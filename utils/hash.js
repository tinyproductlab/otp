/**
 * SHA-1 / SHA-256 / HMAC —— 纯 JS 实现
 *
 * 小程序没有 WebCrypto,TOTP 的 HMAC-SHA1 和备份的 PBKDF2-HMAC-SHA256 都得自己实现。
 * 全部输入输出统一用 Uint8Array,避免字符串编码踩坑。
 *
 * 已用标准测试向量验证(见 _test/verify.js):
 *   - SHA-1 / SHA-256 空串与 "abc"
 *   - HMAC-SHA1 / HMAC-SHA256 RFC 2202 / RFC 4231
 */

function rotl32(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function rotr32(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** 按 SHA-1/SHA-256 的规则补位:0x80 + 零 + 64bit 大端比特长度 */
function padBlocks(bytes) {
  const bitLenHi = Math.floor(bytes.length / 0x20000000);
  const bitLenLo = (bytes.length << 3) >>> 0;
  let total = bytes.length + 1;
  const remainder = total % 64;
  total += remainder <= 56 ? 56 - remainder : 120 - remainder;
  const out = new Uint8Array(total + 8);
  out.set(bytes);
  out[bytes.length] = 0x80;
  const view = new DataView(out.buffer);
  view.setUint32(total, bitLenHi, false);
  view.setUint32(total + 4, bitLenLo, false);
  return out;
}

function sha1(bytes) {
  const message = padBlocks(bytes);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  const view = new DataView(message.buffer);

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 80; i++) {
      w[i] = rotl32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      let f;
      let k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl32(a, 5) + (f >>> 0) + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl32(b, 30);
      b = a;
      a = temp;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }

  const digest = new Uint8Array(20);
  const out = new DataView(digest.buffer);
  for (let i = 0; i < 5; i++) out.setUint32(i * 4, h[i], false);
  return digest;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(bytes) {
  const message = padBlocks(bytes);
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Uint32Array(64);
  const view = new DataView(message.buffer);

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i] + next[i]) >>> 0;
  }

  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) out.setUint32(i * 4, h[i], false);
  return digest;
}

/**
 * HMAC(RFC 2104)。两种摘要的 block size 都是 64 字节。
 * @param {(b: Uint8Array) => Uint8Array} hashFn sha1 或 sha256
 * @param {number} digestLength 20 或 32
 */
function hmac(hashFn, digestLength, key, message) {
  const blockSize = 64;
  let k = key;
  if (k.length > blockSize) k = hashFn(k);
  if (k.length < blockSize) {
    const padded = new Uint8Array(blockSize);
    padded.set(k);
    k = padded;
  }

  const inner = new Uint8Array(blockSize + message.length);
  const outer = new Uint8Array(blockSize + digestLength);
  for (let i = 0; i < blockSize; i++) {
    inner[i] = k[i] ^ 0x36;
    outer[i] = k[i] ^ 0x5c;
  }
  inner.set(message, blockSize);
  outer.set(hashFn(inner), blockSize);
  return hashFn(outer);
}

const hmacSha1 = (key, message) => hmac(sha1, 20, key, message);
const hmacSha256 = (key, message) => hmac(sha256, 32, key, message);

/** PBKDF2-HMAC-SHA256(RFC 8018)。迭代数高时务必放 Worker,主线程会卡。 */
function pbkdf2Sha256(password, salt, iterations, keyLength) {
  const blocks = Math.ceil(keyLength / 32);
  const out = new Uint8Array(blocks * 32);
  const input = new Uint8Array(salt.length + 4);
  input.set(salt);

  for (let block = 1; block <= blocks; block++) {
    input[salt.length] = (block >>> 24) & 0xff;
    input[salt.length + 1] = (block >>> 16) & 0xff;
    input[salt.length + 2] = (block >>> 8) & 0xff;
    input[salt.length + 3] = block & 0xff;

    let u = hmacSha256(password, input);
    const accumulator = u.slice();
    for (let i = 1; i < iterations; i++) {
      u = hmacSha256(password, u);
      for (let j = 0; j < 32; j++) accumulator[j] ^= u[j];
    }
    out.set(accumulator, (block - 1) * 32);
  }
  return out.slice(0, keyLength);
}

// ---- 编码辅助 ----

function utf8ToBytes(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
      i++;
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(out);
}

function bytesToUtf8(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b < 0xf0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      );
      i += 3;
    } else {
      const code =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      const adjusted = code - 0x10000;
      out += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
      i += 4;
    }
  }
  return out;
}

function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
    out += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
    out += b2 === undefined ? '=' : B64[b2 & 63];
  }
  return out;
}

function base64ToBytes(text) {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let position = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n0 = B64.indexOf(clean[i]);
    const n1 = B64.indexOf(clean[i + 1]);
    const n2 = clean[i + 2] ? B64.indexOf(clean[i + 2]) : -1;
    const n3 = clean[i + 3] ? B64.indexOf(clean[i + 3]) : -1;
    out[position++] = (n0 << 2) | (n1 >> 4);
    if (n2 >= 0) out[position++] = ((n1 & 15) << 4) | (n2 >> 2);
    if (n3 >= 0) out[position++] = ((n2 & 3) << 6) | n3;
  }
  return out.slice(0, position);
}

/** 常量时间比较,校验 MAC / 摘要时用,避免时序泄露 */
function equalBytes(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

module.exports = {
  sha1,
  sha256,
  hmacSha1,
  hmacSha256,
  pbkdf2Sha256,
  utf8ToBytes,
  bytesToUtf8,
  bytesToHex,
  hexToBytes,
  bytesToBase64,
  base64ToBytes,
  equalBytes,
};
