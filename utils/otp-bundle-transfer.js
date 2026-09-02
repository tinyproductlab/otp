/*
 * 全量 OTP 加密迁移二维码协议 OTPB1。
 *
 * 一份完整的 AES-GCM 加密容器会被拆成多张尺寸受控的二维码：
 * OTPB1.<会话ID>.<当前张>-<总张数>.<Base64URL(二进制分片)>
 *
 * 分片序号和会话 ID 只用于扫码收集；真正的完整性由组装后的 AES-GCM 容器保证。
 * 因此混入、替换或重排分片都会在最终认证解密时失败。
 */

const backup = require('./backup.js');
const transfer = require('./otp-transfer.js');
const { utf8ToBytes, bytesToUtf8 } = require('./hash.js');
const { gcmEncrypt, gcmDecrypt } = require('./aes.js');
const random = require('./random.js');

const PREFIX = 'OTPB1.';
const MAGIC = utf8ToBytes('OTB1');
const VERSION = 1;
const DEFAULT_ITERATIONS = backup.DEFAULT_ITERATIONS || 120000;
const AAD_LENGTH = 45;
const HEADER_LENGTH = 61;
const CHUNK_BYTES = 520;
const MAX_PARTS = 30;
const MAX_TOKENS = 200;

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
  return transfer._internal.toBase64Url(bytes);
}

function fromBase64Url(text) {
  return transfer._internal.fromBase64Url(text);
}

function normalizeTokens(tokens) {
  if (!Array.isArray(tokens) || !tokens.length) throw createError('BUNDLE_EMPTY', '暂无可迁移的验证码');
  if (tokens.length > MAX_TOKENS) throw createError('BUNDLE_TOO_MANY', `一次最多迁移 ${MAX_TOKENS} 条验证码`);
  return tokens.map((token) => transfer._internal.normalizeToken(token));
}

function resolveProtection(password, expiryMinutes, nowSeconds) {
  const accessPassword = transfer._internal.normalizePassword(password);
  const expiresAt = transfer._internal.resolveExpiry(expiryMinutes === undefined ? 15 : expiryMinutes, nowSeconds);
  if (!accessPassword && !expiresAt) {
    throw createError('BUNDLE_PROTECTION', '请设置至少 6 位访问密码，或选择有效期');
  }
  return { accessPassword, expiresAt };
}

function assertMagic(data) {
  if (!data || data.length < HEADER_LENGTH) throw createError('BUNDLE_FORMAT', '迁移二维码内容不完整');
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (data[index] !== MAGIC[index]) throw createError('BUNDLE_FORMAT', '这不是全量 OTP 迁移二维码');
  }
}

function getHeader(data) {
  assertMagic(data);
  const version = data[4];
  if (version !== VERSION) throw createError('BUNDLE_VERSION', `不支持的全量迁移版本 v${version}`);
  const iterations = readUint32BE(data, 5);
  if (iterations < 1000 || iterations > 1000000) throw createError('BUNDLE_FORMAT', '迁移二维码参数异常');
  const createdAt = readUint32BE(data, 9);
  const expiresAt = readUint32BE(data, 13);
  const salt = data.subarray(17, 33);
  const iv = data.subarray(33, 45);
  const tag = data.subarray(45, 61);
  const ciphertext = data.subarray(61);
  if (!ciphertext.length) throw createError('BUNDLE_FORMAT', '迁移二维码内容不完整');
  return { version, iterations, createdAt, expiresAt, salt, iv, tag, ciphertext, aad: data.subarray(0, AAD_LENGTH) };
}

function isExpired(header, nowSeconds) {
  return header.expiresAt > 0 && nowSeconds >= header.expiresAt;
}

function createSessionId() {
  return toBase64Url(random.bytesSync(6));
}

function toParts(container, sessionId) {
  const total = Math.ceil(container.length / CHUNK_BYTES);
  if (total > MAX_PARTS) {
    throw createError('BUNDLE_TOO_LARGE', '验证码较多，二维码数量会过多，请改用微信加密文件导出');
  }
  const parts = [];
  for (let index = 0; index < total; index += 1) {
    const start = index * CHUNK_BYTES;
    const chunk = container.subarray(start, Math.min(container.length, start + CHUNK_BYTES));
    parts.push(`${PREFIX}${sessionId}.${index + 1}-${total}.${toBase64Url(chunk)}`);
  }
  return parts;
}

function parsePart(payload) {
  const text = String(payload || '').trim();
  const match = /^OTPB1\.([A-Za-z0-9_-]{8})\.([1-9]\d*)-([1-9]\d*)\.([A-Za-z0-9_-]+)$/.exec(text);
  if (!match) throw createError('BUNDLE_FORMAT', '这不是完整 OTP 迁移二维码');
  const part = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(part) || !Number.isSafeInteger(total) || total > MAX_PARTS || part > total) {
    throw createError('BUNDLE_FORMAT', '迁移二维码分片信息异常');
  }
  const chunk = fromBase64Url(match[4]);
  if (!chunk.length || chunk.length > CHUNK_BYTES) throw createError('BUNDLE_FORMAT', '迁移二维码分片内容异常');
  return { payload: text, sessionId: match[1], part, total, chunk };
}

function assemble(parts) {
  const source = Array.isArray(parts) ? parts : Object.keys(parts || {}).map((key) => parts[key]);
  if (!source.length) throw createError('BUNDLE_INCOMPLETE', '请先扫描迁移二维码');
  const parsed = source.map((item) => (typeof item === 'string' ? parsePart(item) : item));
  const sessionId = parsed[0].sessionId;
  const total = parsed[0].total;
  if (parsed.length !== total) throw createError('BUNDLE_INCOMPLETE', `迁移二维码未收齐，还差 ${total - parsed.length} 张`);
  const chunks = new Array(total);
  parsed.forEach((item) => {
    if (!item || item.sessionId !== sessionId || item.total !== total || !item.part || !item.chunk) {
      throw createError('BUNDLE_MISMATCH', '迁移二维码不属于同一组，请重新扫描');
    }
    if (chunks[item.part - 1]) throw createError('BUNDLE_DUPLICATE_PART', '迁移二维码中有重复分片');
    chunks[item.part - 1] = item.chunk;
  });
  if (chunks.some((chunk) => !chunk)) throw createError('BUNDLE_INCOMPLETE', '迁移二维码未收齐，请继续扫描');
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const container = new Uint8Array(length);
  let offset = 0;
  chunks.forEach((chunk) => {
    container.set(chunk, offset);
    offset += chunk.length;
  });
  return { sessionId, total, container, header: getHeader(container) };
}

async function encrypt(tokens, password, options = {}) {
  const normalizedTokens = normalizeTokens(tokens);
  const nowSeconds = Number.isFinite(options.nowSeconds) ? Math.floor(options.nowSeconds) : Math.floor(Date.now() / 1000);
  const { accessPassword, expiresAt } = resolveProtection(password, options.expiryMinutes, nowSeconds);
  const iterations = options.iterations || DEFAULT_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1000000) {
    throw createError('BUNDLE_FORMAT', '迁移二维码迭代参数异常');
  }

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
  const plaintext = utf8ToBytes(JSON.stringify({ type: 'otp-bundle', tokens: normalizedTokens }));
  const encrypted = gcmEncrypt(key, iv, plaintext, header.subarray(0, AAD_LENGTH));
  const container = new Uint8Array(HEADER_LENGTH + encrypted.ciphertext.length);
  container.set(header, 0);
  container.set(encrypted.tag, 45);
  container.set(encrypted.ciphertext, HEADER_LENGTH);
  const sessionId = createSessionId();
  const payloads = toParts(container, sessionId);
  return {
    payloads,
    sessionId,
    total: payloads.length,
    tokenCount: normalizedTokens.length,
    createdAt: nowSeconds,
    expiresAt,
    permanent: expiresAt === 0,
    passwordProtected: !!accessPassword,
  };
}

function inspect(parts, options = {}) {
  const assembled = assemble(parts);
  const nowSeconds = Number.isFinite(options.nowSeconds) ? Math.floor(options.nowSeconds) : Math.floor(Date.now() / 1000);
  return {
    sessionId: assembled.sessionId,
    total: assembled.total,
    version: assembled.header.version,
    createdAt: assembled.header.createdAt,
    expiresAt: assembled.header.expiresAt,
    permanent: assembled.header.expiresAt === 0,
    expired: isExpired(assembled.header, nowSeconds),
    remainingSeconds: assembled.header.expiresAt === 0 ? 0 : Math.max(0, assembled.header.expiresAt - nowSeconds),
  };
}

async function decrypt(parts, password, options = {}) {
  const accessPassword = transfer._internal.normalizePassword(password);
  const assembled = assemble(parts);
  const nowSeconds = Number.isFinite(options.nowSeconds) ? Math.floor(options.nowSeconds) : Math.floor(Date.now() / 1000);
  if (isExpired(assembled.header, nowSeconds)) throw createError('BUNDLE_EXPIRED', '迁移二维码已过期，请让导出方重新生成');

  const key = await backup._internal.deriveKey(accessPassword, assembled.header.salt, assembled.header.iterations, options.onProgress);
  let plaintext;
  try {
    plaintext = gcmDecrypt(key, assembled.header.iv, assembled.header.ciphertext, assembled.header.tag, assembled.header.aad);
  } catch (error) {
    throw createError('BUNDLE_DECRYPT', '访问密码错误，或二维码已损坏');
  }
  let decoded;
  try {
    decoded = JSON.parse(bytesToUtf8(plaintext));
  } catch (error) {
    throw createError('BUNDLE_FORMAT', '迁移二维码内容无法解析');
  }
  if (!decoded || decoded.type !== 'otp-bundle' || !Array.isArray(decoded.tokens)) {
    throw createError('BUNDLE_FORMAT', '迁移二维码内容不正确');
  }
  const tokens = normalizeTokens(decoded.tokens).map(({ type, ...token }) => token);
  return { tokens, meta: inspect(parts, { nowSeconds }) };
}

module.exports = {
  PREFIX,
  VERSION,
  CHUNK_BYTES,
  MAX_PARTS,
  MAX_TOKENS,
  encrypt,
  decrypt,
  inspect,
  parsePart,
  assemble,
  isBundlePayload: (value) => String(value || '').trim().startsWith(PREFIX),
  _internal: { getHeader, toParts, normalizeTokens, resolveProtection },
};
