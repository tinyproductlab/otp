/*
 * 单条 OTP 加密迁移二维码协议 OTPT1。
 *
 * 载荷：OTPT1.<Base64URL(二进制容器)>。
 * 容器头部被作为 AES-GCM AAD 认证，避免有效期、迭代数、salt 或 IV 被静默篡改。
 * 本模块只处理单条 OTP；全量迁移继续使用微信导入导出的 OTP1 备份文件。
 */

const backup = require('./backup.js');
const { utf8ToBytes, bytesToUtf8, bytesToBase64, base64ToBytes } = require('./hash.js');
const { gcmEncrypt, gcmDecrypt } = require('./aes.js');
const random = require('./random.js');
const totp = require('./totp.js');

const PREFIX = 'OTPT1.';
const MAGIC = utf8ToBytes('OTQ1');
const VERSION = 1;
const DEFAULT_ITERATIONS = backup.DEFAULT_ITERATIONS || 120000;
const AAD_LENGTH = 45;
const HEADER_LENGTH = 61;
const MAX_PAYLOAD_LENGTH = 1800;
const MIN_PASSWORD_LENGTH = 6;
const EXPIRY_MINUTES = [0, 5, 15, 60, 1440];

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function writeUint32BE(target, offset, value) {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readUint32BE(source, offset) {
  return (((source[offset] << 24) | (source[offset + 1] << 16) | (source[offset + 2] << 8) | source[offset + 3]) >>> 0);
}

function toBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(text) {
  const value = String(text || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw createError('TRANSFER_FORMAT', '迁移二维码内容格式不正确');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  try {
    return base64ToBytes(base64);
  } catch (e) {
    throw createError('TRANSFER_FORMAT', '迁移二维码内容无法读取');
  }
}

/** 出错时用来指认是哪一条,不能只说"某条不合法" —— 用户有几十条时无从下手 */
function describeToken(token) {
  const label = [token && token.issuer, token && token.accountName]
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .join(' · ');
  return label || '未命名条目';
}

function normalizeToken(source) {
  const token = source || {};
  const issuer = String(token.issuer || '').trim();
  const accountName = String(token.accountName || '').trim();
  const secret = totp.normalizeSecret(String(token.secret || ''));
  const who = describeToken(token);
  if (!issuer && !accountName) throw createError('TRANSFER_TOKEN', '有一条验证码既没有发行商也没有账号,无法迁移');
  if (!totp.isValidSecret(secret)) throw createError('TRANSFER_TOKEN', `「${who}」的密钥不合法`);

  // 位数和算法必须**如实**带走。原来写死 `=== 8 ? 8 : 6`,7 位令牌迁移一次
  // 就被静默改成 6 位 —— 到了新设备验证码永远对不上,而界面上看不出任何异常。
  const digits = Number(token.digits) || 6;
  if (totp.SUPPORTED_DIGITS.indexOf(digits) < 0) {
    throw createError('TRANSFER_TOKEN', `「${who}」是 ${digits} 位验证码,迁移二维码支持 ${totp.SUPPORTED_DIGITS.join(' / ')} 位`);
  }
  const period = Number(token.period) || 30;
  if (!Number.isInteger(period) || period < 1 || period > 3600) {
    throw createError('TRANSFER_TOKEN', `「${who}」的刷新周期不合法`);
  }
  const algorithm = String(token.algorithm || 'SHA1').toUpperCase();
  if (totp.SUPPORTED_ALGORITHMS.indexOf(algorithm) < 0) {
    throw createError('TRANSFER_TOKEN', `「${who}」使用 ${algorithm} 算法,迁移二维码暂不支持`);
  }
  return { type: 'otp-transfer', issuer, accountName, secret, digits, period, algorithm };
}

function normalizePassword(password) {
  const value = typeof password === 'string' ? password : '';
  if (value.length > 0 && value.length < MIN_PASSWORD_LENGTH) {
    throw createError('TRANSFER_PASSWORD', `迁移访问密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
  return value;
}

function resolveExpiry(expiryMinutes, nowSeconds) {
  const minutes = Number(expiryMinutes);
  if (EXPIRY_MINUTES.indexOf(minutes) < 0) throw createError('TRANSFER_EXPIRY', '请选择有效期');
  return minutes === 0 ? 0 : nowSeconds + minutes * 60;
}

function assertMagic(data) {
  if (!data || data.length < HEADER_LENGTH) throw createError('TRANSFER_FORMAT', '迁移二维码内容不完整');
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (data[index] !== MAGIC[index]) throw createError('TRANSFER_FORMAT', '这不是加密迁移二维码');
  }
}

function getHeader(data) {
  assertMagic(data);
  const version = data[4];
  if (version !== VERSION) throw createError('TRANSFER_VERSION', `不支持的迁移二维码版本 v${version}`);
  const iterations = readUint32BE(data, 5);
  if (iterations < 1000 || iterations > 1000000) throw createError('TRANSFER_FORMAT', '迁移二维码参数异常');
  const createdAt = readUint32BE(data, 9);
  const expiresAt = readUint32BE(data, 13);
  const salt = data.subarray(17, 33);
  const iv = data.subarray(33, 45);
  const tag = data.subarray(45, 61);
  const ciphertext = data.subarray(61);
  if (!ciphertext.length) throw createError('TRANSFER_FORMAT', '迁移二维码内容不完整');
  return { version, iterations, createdAt, expiresAt, salt, iv, tag, ciphertext, aad: data.subarray(0, AAD_LENGTH) };
}

function isExpired(header, nowSeconds) {
  return header.expiresAt > 0 && nowSeconds >= header.expiresAt;
}

function inspect(payload, options = {}) {
  const text = String(payload || '').trim();
  if (!text.startsWith(PREFIX)) throw createError('TRANSFER_FORMAT', '这不是加密迁移二维码');
  const data = fromBase64Url(text.slice(PREFIX.length));
  const header = getHeader(data);
  const nowSeconds = Number.isFinite(options.nowSeconds) ? Math.floor(options.nowSeconds) : Math.floor(Date.now() / 1000);
  return {
    version: header.version,
    createdAt: header.createdAt,
    expiresAt: header.expiresAt,
    permanent: header.expiresAt === 0,
    expired: isExpired(header, nowSeconds),
    remainingSeconds: header.expiresAt === 0 ? 0 : Math.max(0, header.expiresAt - nowSeconds),
    payloadLength: text.length,
  };
}

async function encrypt(token, password, options = {}) {
  const normalized = normalizeToken(token);
  const accessPassword = normalizePassword(password);
  const nowSeconds = Number.isFinite(options.nowSeconds) ? Math.floor(options.nowSeconds) : Math.floor(Date.now() / 1000);
  const expiresAt = resolveExpiry(options.expiryMinutes === undefined ? 15 : options.expiryMinutes, nowSeconds);
  if (!accessPassword && !expiresAt) {
    throw createError('TRANSFER_PROTECTION', '请设置至少 6 位访问密码，或选择有效期');
  }
  const iterations = options.iterations || DEFAULT_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1000000) throw createError('TRANSFER_FORMAT', '迁移二维码迭代参数异常');

  await random.prefetch();
  const salt = random.bytesSync(16);
  const iv = random.bytesSync(12);
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(MAGIC, 0);
  header[4] = VERSION;
  writeUint32BE(header, 5, iterations);
  writeUint32BE(header, 9, nowSeconds);
  writeUint32BE(header, 13, expiresAt);
  header.set(salt, 17);
  header.set(iv, 33);

  const key = await backup._internal.deriveKey(accessPassword, salt, iterations, options.onProgress);
  const plaintext = utf8ToBytes(JSON.stringify(normalized));
  const encrypted = gcmEncrypt(key, iv, plaintext, header.subarray(0, AAD_LENGTH));
  const container = new Uint8Array(HEADER_LENGTH + encrypted.ciphertext.length);
  container.set(header, 0);
  container.set(encrypted.tag, 45);
  container.set(encrypted.ciphertext, HEADER_LENGTH);
  const payload = PREFIX + toBase64Url(container);
  if (payload.length > MAX_PAYLOAD_LENGTH) throw createError('TRANSFER_TOO_LARGE', '这条验证码无法生成单张迁移二维码，请使用微信导入导出');
  return { payload, createdAt: nowSeconds, expiresAt, permanent: expiresAt === 0, token: normalized };
}

async function decrypt(payload, password, options = {}) {
  const accessPassword = normalizePassword(password);
  const text = String(payload || '').trim();
  if (!text.startsWith(PREFIX)) throw createError('TRANSFER_FORMAT', '这不是加密迁移二维码');
  const data = fromBase64Url(text.slice(PREFIX.length));
  const header = getHeader(data);
  const nowSeconds = Number.isFinite(options.nowSeconds) ? Math.floor(options.nowSeconds) : Math.floor(Date.now() / 1000);
  if (isExpired(header, nowSeconds)) throw createError('TRANSFER_EXPIRED', '迁移二维码已过期，请让导出方重新生成');

  const key = await backup._internal.deriveKey(accessPassword, header.salt, header.iterations, options.onProgress);
  let plaintext;
  try {
    plaintext = gcmDecrypt(key, header.iv, header.ciphertext, header.tag, header.aad);
  } catch (e) {
    throw createError('TRANSFER_DECRYPT', '访问密码错误，或二维码已损坏');
  }
  let decoded;
  try {
    decoded = JSON.parse(bytesToUtf8(plaintext));
  } catch (e) {
    throw createError('TRANSFER_FORMAT', '迁移二维码内容无法解析');
  }
  if (!decoded || decoded.type !== 'otp-transfer') throw createError('TRANSFER_FORMAT', '迁移二维码内容不正确');
  return normalizeToken(decoded);
}

/**
 * 把一批令牌分拣成「能迁移的」和「不能迁移的」。
 *
 * 批量导出不该因为其中一条坏掉就整批失败 —— 用户存了几十条,
 * 里面有一条早年手抄错的密钥,结果一条都导不出来,而且不告诉他是哪条。
 * 调用方拿到 invalid 列表后可以提示用户,再决定是否导出其余的。
 *
 * @returns {{valid: object[], invalid: Array<{token: object, label: string, reason: string}>}}
 */
function partitionTokens(tokens) {
  const valid = [];
  const invalid = [];
  (Array.isArray(tokens) ? tokens : []).forEach((token) => {
    try {
      normalizeToken(token);
      valid.push(token);
    } catch (error) {
      invalid.push({ token, label: describeToken(token), reason: error.message });
    }
  });
  return { valid, invalid };
}

module.exports = {
  PREFIX,
  VERSION,
  DEFAULT_ITERATIONS,
  MAX_PAYLOAD_LENGTH,
  MIN_PASSWORD_LENGTH,
  EXPIRY_MINUTES,
  encrypt,
  decrypt,
  inspect,
  partitionTokens,
  describeToken,
  isTransferPayload: (value) => String(value || '').trim().startsWith(PREFIX),
  _internal: { toBase64Url, fromBase64Url, getHeader, normalizeToken, normalizePassword, resolveExpiry },
};
