/**
 * AES-256-GCM —— 纯 JS 实现(仅正向加密,GCM 的解密也只用正向)
 *
 * 小程序没有 WebCrypto,备份加密只能自己实现。
 * S-box 是按 GF(2^8) 规则**程序生成**的,不是手抄常量表 —— 少一整类抄错的风险。
 *
 * 已用 NIST GCM 官方向量 + 对 node crypto 的随机差分测试验证(见 _test/verify-aes.js)。
 */

// ---- S-box 生成(标准生成循环:GF(2^8) 乘法逆元 + 仿射变换)----
const SBOX = new Uint8Array(256);
(function buildSbox() {
  const rotl8 = (x, n) => ((x << n) | (x >>> (8 - n))) & 0xff;
  let p = 1;
  let q = 1;
  do {
    // p *= 3
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x11b : 0)) & 0xff;
    // q /= 3
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    SBOX[p] = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
})();

/** GF(2^8) 乘 2 */
const xtime = (x) => ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;

const RCON = new Uint8Array([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8]);

/**
 * AES-256 密钥扩展。Nk=8, Nr=14 → 15 组轮密钥,共 240 字节。
 * @param {Uint8Array} key 32 字节
 */
function expandKey(key) {
  if (key.length !== 32) throw new Error('AES-256 需要 32 字节密钥');
  const rounds = 14;
  const totalWords = 4 * (rounds + 1); // 60
  const w = new Uint8Array(totalWords * 4);
  w.set(key);

  for (let i = 8; i < totalWords; i++) {
    const o = i * 4;
    let t0 = w[o - 4];
    let t1 = w[o - 3];
    let t2 = w[o - 2];
    let t3 = w[o - 1];

    if (i % 8 === 0) {
      // RotWord + SubWord + Rcon
      const rotated = [t1, t2, t3, t0];
      t0 = SBOX[rotated[0]] ^ RCON[i / 8 - 1];
      t1 = SBOX[rotated[1]];
      t2 = SBOX[rotated[2]];
      t3 = SBOX[rotated[3]];
    } else if (i % 8 === 4) {
      // Nk > 6 时的额外 SubWord
      t0 = SBOX[t0];
      t1 = SBOX[t1];
      t2 = SBOX[t2];
      t3 = SBOX[t3];
    }

    w[o] = w[o - 32] ^ t0;
    w[o + 1] = w[o - 31] ^ t1;
    w[o + 2] = w[o - 30] ^ t2;
    w[o + 3] = w[o - 29] ^ t3;
  }
  return w;
}

/**
 * 单块加密(16 字节),结果写回 state。
 * @param {Uint8Array} roundKeys expandKey 的输出
 * @param {Uint8Array} state 16 字节,原地修改
 */
function encryptBlock(roundKeys, state) {
  const rounds = 14;

  for (let i = 0; i < 16; i++) state[i] ^= roundKeys[i];

  for (let round = 1; round <= rounds; round++) {
    // SubBytes
    for (let i = 0; i < 16; i++) state[i] = SBOX[state[i]];

    // ShiftRows(列主序存储:字节 i 属于第 i%4 行、第 floor(i/4) 列)
    let t = state[1];
    state[1] = state[5];
    state[5] = state[9];
    state[9] = state[13];
    state[13] = t;

    t = state[2];
    state[2] = state[10];
    state[10] = t;
    t = state[6];
    state[6] = state[14];
    state[14] = t;

    t = state[15];
    state[15] = state[11];
    state[11] = state[7];
    state[7] = state[3];
    state[3] = t;

    // MixColumns(最后一轮跳过)
    if (round !== rounds) {
      for (let c = 0; c < 16; c += 4) {
        const a0 = state[c];
        const a1 = state[c + 1];
        const a2 = state[c + 2];
        const a3 = state[c + 3];
        const all = a0 ^ a1 ^ a2 ^ a3;
        state[c] ^= all ^ xtime(a0 ^ a1);
        state[c + 1] ^= all ^ xtime(a1 ^ a2);
        state[c + 2] ^= all ^ xtime(a2 ^ a3);
        state[c + 3] ^= all ^ xtime(a3 ^ a0);
      }
    }

    // AddRoundKey
    const ko = round * 16;
    for (let i = 0; i < 16; i++) state[i] ^= roundKeys[ko + i];
  }
  return state;
}

// ---- GHASH:GF(2^128) 乘法。注意 GCM 用的是"bit 0 = 字节 0 的最高位"这种反序约定 ----

function ghashMultiply(x, y) {
  const z = new Uint8Array(16);
  const v = y.slice();
  for (let i = 0; i < 128; i++) {
    if ((x[i >> 3] >> (7 - (i & 7))) & 1) {
      for (let j = 0; j < 16; j++) z[j] ^= v[j];
    }
    const lsb = v[15] & 1;
    for (let j = 15; j > 0; j--) {
      v[j] = ((v[j] >>> 1) | ((v[j - 1] & 1) << 7)) & 0xff;
    }
    v[0] = v[0] >>> 1;
    if (lsb) v[0] ^= 0xe1; // R = 11100001 || 0^120
  }
  return z;
}

/** GHASH,data 长度必须是 16 的倍数(调用方负责补零) */
function ghash(h, data) {
  let y = new Uint8Array(16);
  for (let offset = 0; offset < data.length; offset += 16) {
    for (let i = 0; i < 16; i++) y[i] ^= data[offset + i];
    y = ghashMultiply(y, h);
  }
  return y;
}

function incrementCounter32(counter) {
  for (let i = 15; i >= 12; i--) {
    counter[i] = (counter[i] + 1) & 0xff;
    if (counter[i] !== 0) break;
  }
}

/** CTR 模式的密钥流异或(GCM 的加解密是同一操作) */
function ctrXor(roundKeys, initialCounter, input) {
  const output = new Uint8Array(input.length);
  const counter = initialCounter.slice();
  const keyStream = new Uint8Array(16);

  for (let offset = 0; offset < input.length; offset += 16) {
    keyStream.set(counter);
    encryptBlock(roundKeys, keyStream);
    const chunk = Math.min(16, input.length - offset);
    for (let i = 0; i < chunk; i++) output[offset + i] = input[offset + i] ^ keyStream[i];
    incrementCounter32(counter);
  }
  return output;
}

/** 拼装 GHASH 的输入:AAD ‖ 零补 ‖ C ‖ 零补 ‖ len(AAD)64 ‖ len(C)64 */
function buildGhashInput(aad, ciphertext) {
  const aadPadded = Math.ceil(aad.length / 16) * 16;
  const ctPadded = Math.ceil(ciphertext.length / 16) * 16;
  const buffer = new Uint8Array(aadPadded + ctPadded + 16);
  buffer.set(aad, 0);
  buffer.set(ciphertext, aadPadded);
  const view = new DataView(buffer.buffer);
  // 比特长度,64 位大端。以 32 位高低位写入,规避 JS 位运算的 32 位上限。
  view.setUint32(aadPadded + ctPadded, Math.floor((aad.length * 8) / 0x100000000), false);
  view.setUint32(aadPadded + ctPadded + 4, (aad.length * 8) >>> 0, false);
  view.setUint32(aadPadded + ctPadded + 8, Math.floor((ciphertext.length * 8) / 0x100000000), false);
  view.setUint32(aadPadded + ctPadded + 12, (ciphertext.length * 8) >>> 0, false);
  return buffer;
}

/**
 * AES-256-GCM 加密。
 * @param {Uint8Array} key 32 字节
 * @param {Uint8Array} iv 12 字节(96 位,GCM 推荐长度)
 * @param {Uint8Array} plaintext
 * @param {Uint8Array} [aad] 附加认证数据,参与认证但不加密
 * @returns {{ciphertext: Uint8Array, tag: Uint8Array}} tag 为 16 字节
 */
function gcmEncrypt(key, iv, plaintext, aad = new Uint8Array(0)) {
  if (iv.length !== 12) throw new Error('GCM 需要 12 字节 IV');
  const roundKeys = expandKey(key);

  const h = encryptBlock(roundKeys, new Uint8Array(16));

  // J0 = IV ‖ 0^31 ‖ 1
  const j0 = new Uint8Array(16);
  j0.set(iv);
  j0[15] = 1;

  const counter = j0.slice();
  incrementCounter32(counter);
  const ciphertext = ctrXor(roundKeys, counter, plaintext);

  const s = ghash(h, buildGhashInput(aad, ciphertext));
  const tagMask = j0.slice();
  encryptBlock(roundKeys, tagMask);
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) tag[i] = s[i] ^ tagMask[i];

  return { ciphertext, tag };
}

/**
 * AES-256-GCM 解密。认证失败抛错 —— 绝不返回未认证的明文。
 * @returns {Uint8Array} 明文
 */
function gcmDecrypt(key, iv, ciphertext, tag, aad = new Uint8Array(0)) {
  if (iv.length !== 12) throw new Error('GCM 需要 12 字节 IV');
  if (tag.length !== 16) throw new Error('GCM tag 必须为 16 字节');
  const roundKeys = expandKey(key);

  const h = encryptBlock(roundKeys, new Uint8Array(16));

  const j0 = new Uint8Array(16);
  j0.set(iv);
  j0[15] = 1;

  const s = ghash(h, buildGhashInput(aad, ciphertext));
  const tagMask = j0.slice();
  encryptBlock(roundKeys, tagMask);
  const expected = new Uint8Array(16);
  for (let i = 0; i < 16; i++) expected[i] = s[i] ^ tagMask[i];

  // 常量时间比较,且必须在解密**之前**校验
  let difference = 0;
  for (let i = 0; i < 16; i++) difference |= expected[i] ^ tag[i];
  if (difference !== 0) throw new Error('数据校验失败:备份已损坏或密码错误');

  const counter = j0.slice();
  incrementCounter32(counter);
  return ctrXor(roundKeys, counter, ciphertext);
}

module.exports = {
  gcmEncrypt,
  gcmDecrypt,
  // 导出供测试用
  _internal: { SBOX, expandKey, encryptBlock, ghash, ghashMultiply },
};
