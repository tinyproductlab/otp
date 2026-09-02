/**
 * 安全随机数(AES-CTR DRBG)
 *
 * 为什么不是简单的"预取池":
 *   小程序的 wx.getRandomValues 是异步的,而密码生成、洗牌这些是同步的紧密循环。
 *   同步循环不会让出事件循环,异步补货永远跑不起来 —— 池必然被抽干。
 *
 * 方案:向系统熵源取一次种子(48 字节),之后用 AES-256-CTR 作为 DRBG
 * 同步产出任意长度。每次补充内部缓冲后立即换密钥(backtracking resistance),
 * 即使运行时状态泄露也无法回推此前产出。
 *
 * ⚠️ 绝不使用 Math.random()。
 */

const { _internal: aesInternal } = require('./aes.js');
const { expandKey, encryptBlock } = aesInternal;

const CHUNK_SIZE = 4096; // 每次生成的密钥流块大小
const RESEED_AFTER_BYTES = 1 << 20; // 产出 1MB 后建议重新播种

let roundKeys = null;
let counter = null;
let buffer = new Uint8Array(0);
let bufferOffset = 0;
let generatedSinceSeed = 0;
let seeding = null;
/** bytesSync 产出超过阈值时置位,由下一次 prefetch() 消化 */
let reseedPending = false;

/** 底层系统熵源:小程序用 wx.getRandomValues,测试环境用 node crypto */
function systemEntropy(length) {
  return new Promise((resolve, reject) => {
    if (typeof wx !== 'undefined' && wx.getRandomValues) {
      wx.getRandomValues({
        length,
        success: (res) => resolve(new Uint8Array(res.randomValues)),
        fail: (err) => reject(new Error('系统随机数不可用: ' + JSON.stringify(err))),
      });
      return;
    }
    try {
      const crypto = require('crypto');
      resolve(new Uint8Array(crypto.randomBytes(length)));
    } catch (e) {
      reject(new Error('没有可用的安全随机源'));
    }
  });
}

function installSeed(material) {
  roundKeys = expandKey(material.slice(0, 32));
  counter = new Uint8Array(16);
  counter.set(material.slice(32, 48));
  buffer = new Uint8Array(0);
  bufferOffset = 0;
  generatedSinceSeed = 0;
}

function incrementCounter(value) {
  for (let i = 15; i >= 0; i--) {
    value[i] = (value[i] + 1) & 0xff;
    if (value[i] !== 0) break;
  }
}

/** 同步生成 length 字节密钥流,推进计数器 */
function keystream(length) {
  const out = new Uint8Array(length);
  const block = new Uint8Array(16);
  for (let offset = 0; offset < length; offset += 16) {
    block.set(counter);
    encryptBlock(roundKeys, block);
    const size = Math.min(16, length - offset);
    out.set(block.subarray(0, size), offset);
    incrementCounter(counter);
  }
  return out;
}

/** 补充内部缓冲,并立即换密钥以获得前向安全 */
function refillBuffer() {
  const fresh = keystream(CHUNK_SIZE);
  const rekeyMaterial = keystream(48);
  installSeedPreservingCount(rekeyMaterial);
  buffer = fresh;
  bufferOffset = 0;
}

function installSeedPreservingCount(material) {
  const previous = generatedSinceSeed;
  installSeed(material);
  generatedSinceSeed = previous;
}

/**
 * 播种 / 重新播种。应用启动时 await 一次即可。
 * 已播种且未达重播阈值时直接返回,可安全地反复调用。
 */
function prefetch(force = false) {
  if (roundKeys && !force && !reseedPending) return Promise.resolve();
  if (seeding) return seeding;
  seeding = systemEntropy(48)
    .then((material) => {
      installSeed(material); // 内部把 generatedSinceSeed 归零
      reseedPending = false;
      seeding = null;
    })
    .catch((err) => {
      seeding = null;
      throw err;
    });
  return seeding;
}

const reseed = () => prefetch(true);

/**
 * 同步取随机字节。长度不限。
 * @throws 尚未播种时抛错(应先 await prefetch())
 */
function bytesSync(length) {
  if (!roundKeys) throw new Error('随机数未初始化,请先 await random.prefetch()');
  if (length <= 0) return new Uint8Array(0);

  generatedSinceSeed += length;
  // 超过阈值就**标记**待重播种。这里是同步接口,拿不到系统熵源(wx.getRandomValues
  // 只有异步版),所以不能在此处真的重播种 —— 但可以让下一次 prefetch()/bytes()
  // 强制去拿新种子。原来阈值只在 prefetch() 里判断,而主路径全是 bytesSync,
  // 于是那个阈值从来没生效过。
  //
  // 注意:即使一直不重播种也不构成漏洞 —— 每 4KB 就换一次密钥(refillBuffer),
  // 已经有前向安全。重播种是为了引入新的系统熵,属于加固而非修补。
  if (generatedSinceSeed >= RESEED_AFTER_BYTES) reseedPending = true;

  // 大请求直接生成,不经缓冲
  if (length > CHUNK_SIZE) {
    const out = keystream(length);
    installSeedPreservingCount(keystream(48));
    return out;
  }

  const out = new Uint8Array(length);
  let written = 0;
  while (written < length) {
    if (bufferOffset >= buffer.length) refillBuffer();
    const take = Math.min(length - written, buffer.length - bufferOffset);
    out.set(buffer.subarray(bufferOffset, bufferOffset + take), written);
    bufferOffset += take;
    written += take;
  }
  return out;
}

/** 异步取随机字节,未播种会自动播种 */
async function bytes(length) {
  await prefetch();
  return bytesSync(length);
}

/**
 * 无偏的 [0, max) 随机整数(拒绝采样)。
 * 直接取模会让靠前取值概率偏高 —— 生成密码时这会系统性削弱强度。
 *
 * 按 max 的大小取足够的字节数:原来固定取 1 字节,`Math.floor(256/max)*max`
 * 在 max > 256 时等于 0,于是"字节 < 0"永远不成立,必然抛"采样失败"。
 * 当前调用方(字符集 ≤ 70、密码 ≤ 128 位)碰不到,但 shuffleSync 是通用工具,
 * 洗一个 300 元素的数组就会炸。
 */
function intBelowSync(max) {
  if (!Number.isInteger(max) || max <= 0) throw new Error('max 必须为正整数');
  if (max === 1) return 0;
  if (max > Number.MAX_SAFE_INTEGER) throw new Error('max 过大');

  // 取够覆盖 max 的字节数,再算出该字节宽度下不产生偏置的上界
  let byteCount = 1;
  while (Math.pow(256, byteCount) < max) byteCount++;
  const space = Math.pow(256, byteCount);
  const limit = Math.floor(space / max) * max; // 超过 limit 的取值一律丢弃

  for (let attempt = 0; attempt < 1000; attempt++) {
    const chunk = bytesSync(byteCount);
    let value = 0;
    for (let i = 0; i < byteCount; i++) value = value * 256 + chunk[i];
    if (value < limit) return value % max;
  }
  throw new Error('随机数采样失败');
}

/** 原地 Fisher-Yates 洗牌 */
function shuffleSync(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = intBelowSync(i + 1);
    const temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
  return array;
}

module.exports = {
  prefetch,
  reseed,
  bytes,
  bytesSync,
  intBelowSync,
  shuffleSync,
  _internal: { isSeeded: () => !!roundKeys, generatedSinceSeed: () => generatedSinceSeed, reseedPending: () => reseedPending },
};
