/* 验证 utils/aes.js。运行: node _test/verify-aes.js */
const aes = require('../utils/aes.js');
const h = require('../utils/hash.js');
const crypto = require('crypto');

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}\n      实际: ${actual}\n      期望: ${expected}`);
  }
}

const hex = h.bytesToHex;
const bin = h.hexToBytes;

console.log('\nS-box(程序生成,抽查已知值)');
const { SBOX, expandKey, encryptBlock } = aes._internal;
check('SBOX[0x00]', hex(new Uint8Array([SBOX[0x00]])), '63');
check('SBOX[0x01]', hex(new Uint8Array([SBOX[0x01]])), '7c');
check('SBOX[0x10]', hex(new Uint8Array([SBOX[0x10]])), 'ca');
check('SBOX[0x53]', hex(new Uint8Array([SBOX[0x53]])), 'ed');
check('SBOX[0xff]', hex(new Uint8Array([SBOX[0xff]])), '16');
// S-box 必须是 0..255 的双射
const seen = new Set(SBOX);
check('是双射(256 个互异值)', String(seen.size), '256');

console.log('\nAES-256 单块加密(FIPS-197 附录 C.3)');
{
  const key = bin('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
  const block = bin('00112233445566778899aabbccddeeff');
  const state = block.slice();
  encryptBlock(expandKey(key), state);
  check('C.3 已知答案', hex(state), '8ea2b7ca516745bfeafc49904b496089');
}

console.log('\nAES-256-GCM(NIST 官方向量)');
{
  // NIST GCM Test Case 13: key/iv/pt/aad 全零长度
  const key = bin('0000000000000000000000000000000000000000000000000000000000000000');
  const iv = bin('000000000000000000000000');
  const r = aes.gcmEncrypt(key, iv, new Uint8Array(0));
  check('case 13 tag', hex(r.tag), '530f8afbc74536b9a963b4f1c4cb738b');
  check('case 13 ct', hex(r.ciphertext), '');
}
{
  // NIST GCM Test Case 14: 16 字节全零明文
  const key = bin('0000000000000000000000000000000000000000000000000000000000000000');
  const iv = bin('000000000000000000000000');
  const r = aes.gcmEncrypt(key, iv, new Uint8Array(16));
  check('case 14 ct', hex(r.ciphertext), 'cea7403d4d606b6e074ec5d3baf39d18');
  check('case 14 tag', hex(r.tag), 'd0d1c8a799996bf0265b98b5d48ab919');
}
{
  // NIST GCM Test Case 15: 60 字节明文,无 AAD
  const key = bin('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308');
  const iv = bin('cafebabefacedbaddecaf888');
  const pt = bin(
    'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72' +
    '1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39'
  );
  const r = aes.gcmEncrypt(key, iv, pt);
  check('case 15 ct', hex(r.ciphertext),
    '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa' +
    '8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662');
  check('case 15 tag', hex(r.tag), 'eb9f796c8d356fc31a8433884b696f4f');
}
{
  // NIST GCM Test Case 16: 有 AAD,且明文被截断到 60 字节(测 AAD + 非整块)
  const key = bin('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308');
  const iv = bin('cafebabefacedbaddecaf888');
  const pt = bin(
    'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72' +
    '1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39'
  );
  const aad = bin('feedfacedeadbeeffeedfacedeadbeefabaddad2');
  const r = aes.gcmEncrypt(key, iv, pt, aad);
  check('case 16 ct', hex(r.ciphertext),
    '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa' +
    '8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662');
  check('case 16 tag', hex(r.tag), '76fc6ece0f4e1768cddf8853bb2d551b');
}

console.log('\n解密与认证');
{
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const pt = h.utf8ToBytes('小产品实验室 OTP 备份内容 🔐 test');
  const aad = h.utf8ToBytes('otplab-v1');
  const r = aes.gcmEncrypt(new Uint8Array(key), new Uint8Array(iv), pt, aad);
  const back = aes.gcmDecrypt(new Uint8Array(key), new Uint8Array(iv), r.ciphertext, r.tag, aad);
  check('往返一致', h.bytesToUtf8(back), '小产品实验室 OTP 备份内容 🔐 test');

  // 篡改密文 → 必须抛错
  let threw = false;
  const tampered = r.ciphertext.slice();
  tampered[0] ^= 1;
  try { aes.gcmDecrypt(new Uint8Array(key), new Uint8Array(iv), tampered, r.tag, aad); }
  catch (e) { threw = true; }
  check('篡改密文被拒', String(threw), 'true');

  // 篡改 tag → 必须抛错
  threw = false;
  const badTag = r.tag.slice();
  badTag[15] ^= 1;
  try { aes.gcmDecrypt(new Uint8Array(key), new Uint8Array(iv), r.ciphertext, badTag, aad); }
  catch (e) { threw = true; }
  check('篡改 tag 被拒', String(threw), 'true');

  // AAD 不匹配 → 必须抛错(这是"备份格式版本被换掉"的防线)
  threw = false;
  try { aes.gcmDecrypt(new Uint8Array(key), new Uint8Array(iv), r.ciphertext, r.tag, h.utf8ToBytes('otplab-v2')); }
  catch (e) { threw = true; }
  check('AAD 不匹配被拒', String(threw), 'true');
}

// 随机差分:直接对 node 的 aes-256-gcm 比对,覆盖任意长度明文/AAD
console.log('\n随机差分测试 (vs node aes-256-gcm)');
let diffFail = 0;
for (let round = 0; round < 120; round++) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  // 长度覆盖 0..40 逐个 + 随机大块,确保命中非整块与跨块
  const ptLen = round <= 40 ? round : Math.floor(Math.random() * 5000);
  const aadLen = round % 37;
  const pt = crypto.randomBytes(ptLen);
  const aad = crypto.randomBytes(aadLen);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const refCt = Buffer.concat([cipher.update(pt), cipher.final()]);
  const refTag = cipher.getAuthTag();

  const mine = aes.gcmEncrypt(new Uint8Array(key), new Uint8Array(iv), new Uint8Array(pt), new Uint8Array(aad));

  if (hex(mine.ciphertext) !== refCt.toString('hex')) {
    console.log(`  ✗ 密文不符 ptLen=${ptLen} aadLen=${aadLen}`); diffFail++;
  }
  if (hex(mine.tag) !== refTag.toString('hex')) {
    console.log(`  ✗ tag 不符 ptLen=${ptLen} aadLen=${aadLen}`); diffFail++;
  }
  // 反向:node 加密的,我能解开
  const decrypted = aes.gcmDecrypt(new Uint8Array(key), new Uint8Array(iv), new Uint8Array(refCt), new Uint8Array(refTag), new Uint8Array(aad));
  if (hex(decrypted) !== pt.toString('hex')) {
    console.log(`  ✗ 解密不符 ptLen=${ptLen}`); diffFail++;
  }
}
check('加密/tag/解密 ×120 轮', String(diffFail), '0');

console.log('\n性能(小程序真机会更慢,这里只看量级)');
{
  const key = new Uint8Array(crypto.randomBytes(32));
  const iv = new Uint8Array(crypto.randomBytes(12));
  const payload = new Uint8Array(crypto.randomBytes(256 * 1024));
  const start = Date.now();
  aes.gcmEncrypt(key, iv, payload);
  const elapsed = Date.now() - start;
  console.log(`  256 KB 加密耗时 ${elapsed} ms`);
  check('256KB 在 8 秒内', String(elapsed < 8000), 'true');
}

console.log(`\n${'='.repeat(46)}`);
console.log(fail === 0 ? `全部通过 (${pass}/${pass})` : `通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
