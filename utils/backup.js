/**
 * 备份容器格式 OTP1(小产品实验室 OTP,v1)
 *
 * 刻意**不与安卓的 KSB5/KSB6 保持字节兼容**。理由:
 *   安卓那套要 240k 次 PBKDF2,纯 JS 在手机上要等十几秒;而为了兼容一个
 *   跨端场景去绑死两端的二进制格式,代价远大于收益(iOS 侧为此手写复刻了
 *   一整套 AndroidBackupCrypto,不值得再来一次)。
 *   跨端互导走"导出 JSON 再导入"这种粗粒度方式解决。
 *
 * 容器布局(全部大端):
 *   偏移  长度  内容
 *   0     4     magic "OTP1"
 *   4     1     version = 1
 *   5     4     PBKDF2 迭代数(记录在文件里,以后可调而不废旧备份)
 *   9     16    salt
 *   25    12    IV
 *   37    16    GCM tag
 *   53    ...   密文
 *
 * AAD = 头部前 37 字节。这样迭代数、salt、IV 都被认证保护,
 * 改不动 —— 否则攻击者可以把迭代数改成 1 来加速离线爆破。
 */

const { hmacSha256, utf8ToBytes, bytesToUtf8, bytesToBase64, base64ToBytes } = require('./hash.js');
const { gcmEncrypt, gcmDecrypt } = require('./aes.js');
const random = require('./random.js');

const MAGIC = utf8ToBytes('OTP1');
const VERSION = 1;
const HEADER_LENGTH = 53;
const AAD_LENGTH = 37;

/**
 * 默认迭代数。
 *
 * 桌面 node 实测:240k → 1.6s,150k → 1.0s。手机 JS 引擎大约慢 3~8 倍,
 * 所以 240k 会到十几秒,不可接受。120k 是"手机上几秒内能出结果"与
 * "离线爆破足够贵"之间的折中。
 *
 * 这个值写进了文件头,所以将来调高不会让旧备份失效 —— 可以随设备变快而上调。
 */
const DEFAULT_ITERATIONS = 120000;

/** 每片跑多少次迭代后让出主线程。太小则让出开销占比高,太大则界面卡顿。 */
const CHUNK_ITERATIONS = 2000;

const nextTick = () =>
  new Promise((resolve) => {
    if (typeof setTimeout === 'function') setTimeout(resolve, 0);
    else Promise.resolve().then(resolve);
  });

/**
 * 分片式 PBKDF2-HMAC-SHA256,固定输出 32 字节(单块,dkLen=32)。
 * 每片之间让出主线程,让进度条能动、界面不卡。
 * @param {(ratio: number) => void} [onProgress] 0~1
 */
async function deriveKey(password, salt, iterations, onProgress) {
  const passwordBytes = utf8ToBytes(password);
  const block = new Uint8Array(salt.length + 4);
  block.set(salt);
  block[salt.length + 3] = 1; // 块序号 = 1

  let u = hmacSha256(passwordBytes, block);
  const accumulator = u.slice();

  let done = 1;
  while (done < iterations) {
    const target = Math.min(iterations, done + CHUNK_ITERATIONS);
    for (; done < target; done++) {
      u = hmacSha256(passwordBytes, u);
      for (let i = 0; i < 32; i++) accumulator[i] ^= u[i];
    }
    if (onProgress) onProgress(done / iterations);
    if (done < iterations) await nextTick();
  }
  return accumulator;
}

function writeUint32BE(target, offset, value) {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readUint32BE(source, offset) {
  return (
    ((source[offset] << 24) | (source[offset + 1] << 16) | (source[offset + 2] << 8) | source[offset + 3]) >>> 0
  );
}

/**
 * 加密快照为 OTP1 容器。
 * @param {object} snapshot 任意可 JSON 序列化的对象
 * @param {string} password 用户设定的备份密码
 * @param {{onProgress?: (ratio:number)=>void, iterations?: number}} [options]
 * @returns {Promise<Uint8Array>} 完整容器字节
 */
async function encrypt(snapshot, password, options = {}) {
  // 空密码是用户明确确认后的合法配置；是否允许创建由上层配置流程控制。
  if (typeof password !== 'string') throw new Error('备份密码格式不正确');
  const iterations = options.iterations || DEFAULT_ITERATIONS;

  await random.prefetch();
  const salt = random.bytesSync(16);
  const iv = random.bytesSync(12);

  const header = new Uint8Array(HEADER_LENGTH);
  header.set(MAGIC, 0);
  header[4] = VERSION;
  writeUint32BE(header, 5, iterations);
  header.set(salt, 9);
  header.set(iv, 25);
  // tag 待填(37..53)

  const aad = header.subarray(0, AAD_LENGTH);
  const key = await deriveKey(password, salt, iterations, options.onProgress);
  const plaintext = utf8ToBytes(JSON.stringify(snapshot));
  const { ciphertext, tag } = gcmEncrypt(key, iv, plaintext, aad);

  const container = new Uint8Array(HEADER_LENGTH + ciphertext.length);
  container.set(header, 0);
  container.set(tag, 37);
  container.set(ciphertext, HEADER_LENGTH);
  return container;
}

/** 快速判断一份数据是否 OTP1 容器,不做解密 */
function isContainer(data) {
  if (!data || data.length < HEADER_LENGTH) return false;
  for (let i = 0; i < 4; i++) if (data[i] !== MAGIC[i]) return false;
  return true;
}

/** 读容器头部信息(不需要密码),用于恢复前展示"这份备份是什么" */
function readHeader(data) {
  if (!isContainer(data)) throw new Error('不是本工具的备份文件');
  return {
    version: data[4],
    iterations: readUint32BE(data, 5),
    payloadLength: data.length - HEADER_LENGTH,
  };
}

/**
 * 解密 OTP1 容器。
 * @returns {Promise<object>} 快照对象
 * @throws 密码错误、文件损坏、格式不支持
 */
async function decrypt(data, password, options = {}) {
  if (typeof password !== 'string') throw new Error('请输入备份密码');
  const info = readHeader(data);
  if (info.version !== VERSION) {
    throw new Error(`不支持的备份版本 v${info.version},请升级小程序后重试`);
  }
  // 防御异常迭代数:既防篡改(虽然 AAD 已保护),也防手机被卡死
  if (info.iterations < 1000 || info.iterations > 1000000) {
    throw new Error('备份文件的参数异常,可能已损坏');
  }

  const salt = data.subarray(9, 25);
  const iv = data.subarray(25, 37);
  const tag = data.subarray(37, 53);
  const ciphertext = data.subarray(HEADER_LENGTH);
  const aad = data.subarray(0, AAD_LENGTH);

  const key = await deriveKey(password, salt, info.iterations, options.onProgress);

  let plaintext;
  try {
    plaintext = gcmDecrypt(key, iv, ciphertext, tag, aad);
  } catch (e) {
    // GCM 认证失败:99% 是密码错了,其余是文件损坏。给用户可行动的提示。
    throw new Error('备份密码错误,或文件已损坏');
  }

  try {
    return JSON.parse(bytesToUtf8(plaintext));
  } catch (e) {
    throw new Error('备份内容无法解析,文件可能已损坏');
  }
}

/** 容器 → base64 文本(写入文件 / 放进二维码) */
const toBase64 = (container) => bytesToBase64(container);

/** base64 文本 → 容器 */
const fromBase64 = (text) => base64ToBytes(String(text || '').replace(/\s/g, ''));

/** 备份文件名。前缀用 ASCII,避免中文名在 WebDAV 上的编码问题 */
function suggestFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '_' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds());
  return `OTPLAB_${stamp}.bak`;
}

module.exports = {
  encrypt,
  decrypt,
  isContainer,
  readHeader,
  toBase64,
  fromBase64,
  suggestFilename,
  DEFAULT_ITERATIONS,
  HEADER_LENGTH,
  _internal: { deriveKey },
};
