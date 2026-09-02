/**
 * TOTP(RFC 6238)+ Base32 + otpauth:// URI 解析
 *
 * 算法移植自安卓 utils/OtpHelper.java,但修掉了原实现的一处兜底:
 * 安卓在密钥为空时返回 "empty".getBytes(),会算出一个看着正常但完全无意义的验证码。
 * 这里改成直接抛错 —— 宁可报错,不给用户一个假的验证码。
 *
 * 已用 RFC 6238 官方测试向量验证(见 _test/verify-totp.js)。
 */

const { hmacSha1, hmacSha256, utf8ToBytes } = require('./hash.js');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 本实现支持的摘要算法。SHA512 需要 64 位运算,纯 JS 代价太大,暂不支持。 */
const SUPPORTED_ALGORITHMS = ['SHA1', 'SHA256'];
/** 支持的位数。6 是绝对主流,少数发行商用 7 或 8。 */
const SUPPORTED_DIGITS = [6, 7, 8];

/** 规范化密钥:去空格、去连字符、转大写。用户手抄的密钥经常带空格。 */
function normalizeSecret(secret) {
  return (secret || '').replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Base32 解码(RFC 4648,无填充)。
 * @throws 密钥为空或不含任何合法字符时抛错
 */
function base32Decode(value) {
  const normalized = normalizeSecret(value).replace(/=+$/, '');
  if (!normalized) throw new Error('密钥为空');

  const out = [];
  let buffer = 0;
  let bits = 0;
  let valid = 0;

  for (let i = 0; i < normalized.length; i++) {
    const index = BASE32_ALPHABET.indexOf(normalized[i]);
    if (index < 0) continue; // 跳过非法字符,兼容用户粘贴带格式的密钥
    valid++;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  if (valid === 0) throw new Error('密钥不是合法的 Base32');
  return new Uint8Array(out);
}

function base32Encode(bytes) {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * 8 字节大端计数器。
 * 不用位运算 —— JS 位运算只有 32 位,计数器超过 2^32 会静默出错
 * (RFC 6238 的 T=20000000000 向量正好能测出这个 bug)。
 */
function counterToBytes(counter) {
  const out = new Uint8Array(8);
  let high = Math.floor(counter / 0x100000000);
  let low = counter % 0x100000000;
  for (let i = 7; i >= 4; i--) {
    out[i] = low % 256;
    low = Math.floor(low / 256);
  }
  for (let i = 3; i >= 0; i--) {
    out[i] = high % 256;
    high = Math.floor(high / 256);
  }
  return out;
}

/**
 * 计算 TOTP 验证码。
 * @param {{secret: string, digits?: number, period?: number, algorithm?: string}} token
 * @param {number} millis 当前毫秒时间戳
 * @returns {string} 补零到 digits 位的验证码
 */
function code(token, millis = Date.now()) {
  const period = Math.max(1, token.period || 30);
  const digits = token.digits > 0 ? token.digits : 6;
  const counter = Math.floor(Math.floor(millis / 1000) / period);

  const key = base32Decode(token.secret);
  const data = counterToBytes(counter);

  // 绝大多数发行商用 SHA1;少数(如部分银行)用 SHA256。
  // 不认识的算法必须抛错:算出来的码看着正常但永远对不上,
  // 用户会以为是服务方的问题,查一整天都查不到自己身上。
  const algorithm = (token.algorithm || 'SHA1').toUpperCase();
  if (SUPPORTED_ALGORITHMS.indexOf(algorithm) < 0) {
    throw new Error(`暂不支持 ${algorithm} 算法的验证码`);
  }
  const hash = algorithm === 'SHA256' ? hmacSha256(key, data) : hmacSha1(key, data);

  // 动态截断(RFC 4226 §5.3)
  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  const modulo = Math.pow(10, digits);
  return String(binary % modulo).padStart(digits, '0');
}

/** 当前周期剩余秒数,用于倒计时环 */
function remainingSeconds(token, millis = Date.now()) {
  const period = Math.max(1, token.period || 30);
  return period - (Math.floor(millis / 1000) % period);
}

/** 校验密钥能否算出验证码,给"添加"表单做即时校验 */
function isValidSecret(secret) {
  try {
    base32Decode(secret);
    return true;
  } catch (e) {
    return false;
  }
}

function decodeComponent(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch (e) {
    return value;
  }
}

/**
 * 解析 otpauth:// URI(扫码添加的主要入口)。
 * 手写解析而非用 URL —— 小程序环境的 URL 实现不完整,且这类 URI 常有不规范写法。
 * @returns {{issuer: string, accountName: string, secret: string, digits: number, period: number, algorithm: string}}
 */
function parseUri(raw) {
  const text = (raw || '').trim();
  if (!/^otpauth:\/\//i.test(text)) throw new Error('不是有效的 TOTP 二维码');

  const withoutScheme = text.slice(text.indexOf('://') + 3);
  const queryIndex = withoutScheme.indexOf('?');
  const pathPart = queryIndex >= 0 ? withoutScheme.slice(0, queryIndex) : withoutScheme;
  const queryPart = queryIndex >= 0 ? withoutScheme.slice(queryIndex + 1) : '';

  // 类型必须是 totp。以前只校验 scheme,hotp 的码会被当成 totp 处理 ——
  // HOTP 是按次数递增的计数器,拿时间去算必然错,而且错得很安静。
  const slashIndex = pathPart.indexOf('/');
  const kind = (slashIndex >= 0 ? pathPart.slice(0, slashIndex) : pathPart).toLowerCase();
  if (kind === 'hotp') {
    throw new Error('这是 HOTP(计数器)二维码，本工具只支持基于时间的 TOTP');
  }
  if (kind && kind !== 'totp') {
    throw new Error(`不支持的验证码类型：${kind}`);
  }

  const params = {};
  queryPart.split('&').forEach((pair) => {
    if (!pair) return;
    const eq = pair.indexOf('=');
    if (eq < 0) return;
    params[decodeComponent(pair.slice(0, eq)).toLowerCase()] = decodeComponent(pair.slice(eq + 1));
  });

  // path 形如 "totp/Issuer:account" 或 "totp/account"
  const label = decodeComponent(slashIndex >= 0 ? pathPart.slice(slashIndex + 1) : '');

  let issuer = params.issuer || '';
  let accountName = label;
  if (label.indexOf(':') >= 0) {
    const parts = label.split(':');
    const labelIssuer = parts.shift().trim();
    if (!issuer) issuer = labelIssuer;
    accountName = parts.join(':').trim();
  }

  const secret = normalizeSecret(params.secret);
  if (!secret) throw new Error('二维码里没有密钥');
  base32Decode(secret); // 提前校验,不合法就在这里抛

  const digits = parseInt(params.digits, 10);
  const period = parseInt(params.period, 10);
  const algorithm = (params.algorithm || 'SHA1').toUpperCase();
  // 算法和位数都不能静默改成默认值 —— 那样存下来的令牌永远算不对,
  // 而界面上看不出任何异常。宁可当场拒绝,让用户知道这个码存不进来。
  if (SUPPORTED_ALGORITHMS.indexOf(algorithm) < 0) {
    throw new Error(`这个二维码用的是 ${algorithm} 算法，本工具暂不支持`);
  }
  if (params.digits !== undefined && SUPPORTED_DIGITS.indexOf(digits) < 0) {
    throw new Error(`这个二维码要求 ${params.digits} 位验证码，本工具支持 6 / 7 / 8 位`);
  }

  return {
    issuer: issuer.trim(),
    accountName: accountName.trim(),
    secret,
    digits: SUPPORTED_DIGITS.indexOf(digits) >= 0 ? digits : 6,
    period: period > 0 ? period : 30,
    algorithm,
  };
}

/** 生成 otpauth:// URI,导出/迁移用 */
function toUri(token) {
  const issuer = token.issuer || '';
  const account = token.accountName || '';
  const label = encodeURIComponent(issuer ? `${issuer}:${account}` : account);
  const query = [
    `secret=${normalizeSecret(token.secret)}`,
    issuer ? `issuer=${encodeURIComponent(issuer)}` : '',
    `algorithm=${token.algorithm || 'SHA1'}`,
    `digits=${token.digits || 6}`,
    `period=${token.period || 30}`,
  ]
    .filter(Boolean)
    .join('&');
  return `otpauth://totp/${label}?${query}`;
}

module.exports = {
  code,
  remainingSeconds,
  parseUri,
  toUri,
  normalizeSecret,
  isValidSecret,
  base32Decode,
  base32Encode,
  SUPPORTED_ALGORITHMS,
  SUPPORTED_DIGITS,
  _internal: { counterToBytes },
};
