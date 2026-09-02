const totp = require('./totp.js');

function utf8Bytes(value) {
  const text = unescape(encodeURIComponent(String(value || '')));
  const bytes = [];
  for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i));
  return bytes;
}

function varint(value) {
  let n = Number(value) >>> 0;
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}

function fieldBytes(field, bytes) {
  return varint((field << 3) | 2).concat(varint(bytes.length), bytes);
}

function fieldString(field, value) {
  return fieldBytes(field, utf8Bytes(value));
}

function fieldVarint(field, value) {
  return varint(field << 3).concat(varint(value));
}

function concatAll(parts) {
  return parts.reduce((all, part) => all.concat(part), []);
}

function base64Encode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  if (typeof wx !== 'undefined' && wx.arrayBufferToBase64) return wx.arrayBufferToBase64(new Uint8Array(bytes).buffer);
  if (typeof btoa === 'function') return btoa(binary);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  return '';
}

function base64Decode(value) {
  const clean = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  if (typeof wx !== 'undefined' && wx.base64ToArrayBuffer) return Array.from(new Uint8Array(wx.base64ToArrayBuffer(clean)));
  if (typeof Buffer !== 'undefined') return Array.from(Buffer.from(clean, 'base64'));
  if (typeof atob === 'function') return Array.from(atob(clean), (char) => char.charCodeAt(0));
  return [];
}

function base32Encode(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0;
  let bits = 0;
  let output = '';
  bytes.forEach((byte) => {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  });
  if (bits) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

function otpParameters(token) {
  const algorithm = String(token.algorithm || 'SHA1').toUpperCase() === 'SHA256' ? 2 : 1;
  const digits = Number(token.digits) === 8 ? 2 : 1;
  return concatAll([
    fieldBytes(1, Array.from(totp.base32Decode(token.secret))),
    token.accountName ? fieldString(2, token.accountName) : [],
    token.issuer ? fieldString(3, token.issuer) : [],
    fieldVarint(4, algorithm),
    fieldVarint(5, digits),
    fieldVarint(6, 2),
  ]);
}

function toUriLines(tokens) {
  return tokens.map((token) => totp.toUri(token)).join('\n') + (tokens.length ? '\n' : '');
}

function toJson(tokens) {
  return JSON.stringify({
    format: 'otp-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    tokens: tokens.map((token) => ({
      issuer: token.issuer || '',
      accountName: token.accountName || '',
      secret: totp.normalizeSecret(token.secret),
      algorithm: token.algorithm || 'SHA1',
      digits: token.digits || 6,
      period: token.period || 30,
      otpauth: totp.toUri(token),
    })),
  }, null, 2);
}

function toGoogleMigration(tokens) {
  const payload = concatAll([
    tokens.map((token) => fieldBytes(1, otpParameters(token))).reduce((all, item) => all.concat(item), []),
    fieldVarint(2, 1),
    fieldVarint(3, tokens.length),
    fieldVarint(4, 0),
    fieldVarint(5, 1),
  ]);
  return `otpauth-migration://offline?data=${encodeURIComponent(base64Encode(payload).replace(/=+$/, ''))}`;
}

function readVarint(bytes, state) {
  let value = 0;
  let shift = 0;
  while (state.index < bytes.length) {
    const byte = bytes[state.index++];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return value >>> 0;
    shift += 7;
  }
  throw new Error('Google Authenticator 数据不完整');
}

function parseProtoMessage(bytes) {
  const fields = {};
  const state = { index: 0 };
  while (state.index < bytes.length) {
    const tag = readVarint(bytes, state);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      fields[field] = readVarint(bytes, state);
    } else if (wire === 2) {
      const length = readVarint(bytes, state);
      const value = bytes.slice(state.index, state.index + length);
      state.index += length;
      if (!fields[field]) fields[field] = [];
      fields[field].push(value);
    } else {
      throw new Error('不支持的 Google Authenticator 数据格式');
    }
  }
  return fields;
}

function bytesText(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(new Uint8Array(bytes));
  return decodeURIComponent(bytes.map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''));
}

function parseGoogleMigration(value) {
  const query = String(value).split('?')[1] || '';
  const dataPair = query.split('&').find((pair) => pair.indexOf('data=') === 0);
  const data = dataPair ? decodeURIComponent(dataPair.slice(5)) : '';
  if (!data) throw new Error('Google Authenticator 导出内容缺少 data');
  const payload = parseProtoMessage(base64Decode(data));
  return (payload[1] || []).map((raw) => {
    const fields = parseProtoMessage(raw);
    const secret = base32Encode(fields[1] && fields[1][0] ? fields[1][0] : []);
    if (!secret) throw new Error('Google Authenticator 中存在空密钥');
    return {
      issuer: fields[3] && fields[3][0] ? bytesText(fields[3][0]) : '',
      accountName: fields[2] && fields[2][0] ? bytesText(fields[2][0]) : '',
      secret,
      algorithm: fields[4] && fields[4][0] === 2 ? 'SHA256' : 'SHA1',
      digits: fields[5] && fields[5][0] === 2 ? 8 : 6,
      period: 30,
    };
  });
}

function parseJson(text) {
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : parsed.tokens;
  if (!Array.isArray(list)) throw new Error('JSON 中没有 tokens 数组');
  return list.map((item) => {
    if (typeof item === 'string') return totp.parseUri(item);
    if (item.otpauth) return totp.parseUri(item.otpauth);
    const token = {
      issuer: String(item.issuer || ''),
      accountName: String(item.accountName || item.account || ''),
      secret: totp.normalizeSecret(item.secret),
      algorithm: String(item.algorithm || 'SHA1').toUpperCase() === 'SHA256' ? 'SHA256' : 'SHA1',
      digits: Number(item.digits) === 8 ? 8 : 6,
      period: Number(item.period) > 0 ? Number(item.period) : 30,
    };
    if (!totp.isValidSecret(token.secret)) throw new Error('JSON 中存在无效密钥');
    return token;
  });
}

function parseImportText(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  if (raw.indexOf('otpauth-migration://') === 0) return parseGoogleMigration(raw);
  if (raw[0] === '{' || raw[0] === '[') return parseJson(raw);
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => totp.parseUri(line));
}

module.exports = { toUriLines, toJson, toGoogleMigration, parseImportText };
