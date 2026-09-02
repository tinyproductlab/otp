/* 验证 utils/totp.js。运行: node _test/verify-totp.js */
const totp = require('../utils/totp.js');
const h = require('../utils/hash.js');

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  if (String(actual) === String(expected)) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}\n      实际: ${actual}\n      期望: ${expected}`);
  }
}

// RFC 6238 的种子是 ASCII "12345678901234567890",转成 Base32 才是我们的输入格式
const seed = totp.base32Encode(h.utf8ToBytes('12345678901234567890'));
console.log(`\nRFC 6238 种子 Base32 = ${seed}`);
check('种子编码正确', seed, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');

console.log('\nRFC 6238 官方向量(SHA1, 8 位)');
const vectors = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  // 这一条超过 2^32 秒,专门测 64 位计数器 —— 用位运算实现会在这里挂
  [20000000000, '65353130'],
];
vectors.forEach(([seconds, expected]) => {
  const actual = totp.code({ secret: seed, digits: 8, period: 30, algorithm: 'SHA1' }, seconds * 1000);
  check(`T=${seconds}`, actual, expected);
});

console.log('\nRFC 6238 官方向量(SHA256, 8 位)');
// SHA256 的种子是 32 字节: "12345678901234567890123456789012"
const seed256 = totp.base32Encode(h.utf8ToBytes('12345678901234567890123456789012'));
[
  [59, '46119246'],
  [1111111109, '68084774'],
  [1111111111, '67062674'],
  [1234567890, '91819424'],
  [2000000000, '90698825'],
  [20000000000, '77737706'],
].forEach(([seconds, expected]) => {
  const actual = totp.code({ secret: seed256, digits: 8, period: 30, algorithm: 'SHA256' }, seconds * 1000);
  check(`T=${seconds}`, actual, expected);
});

console.log('\n64 位计数器编码');
const c2b = totp._internal.counterToBytes;
check('0', h.bytesToHex(c2b(0)), '0000000000000000');
check('1', h.bytesToHex(c2b(1)), '0000000000000001');
check('2^31 (位运算会在此变负)', h.bytesToHex(c2b(2147483648)), '0000000080000000');
check('2^32', h.bytesToHex(c2b(4294967296)), '0000000100000000');
check('666666666 (T=20000000000/30)', h.bytesToHex(c2b(666666666)), '0000000027bc86aa');

console.log('\n6 位常规用法');
check('6 位长度', totp.code({ secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30 }, 0).length, 6);
check('全数字', /^\d{6}$/.test(totp.code({ secret: 'JBSWY3DPEHPK3PXP' }, Date.now())), 'true');
// 同一周期内结果必须稳定,跨周期必须变化
const t0 = 1700000000000;
check('同周期一致', totp.code({ secret: 'JBSWY3DPEHPK3PXP' }, t0), totp.code({ secret: 'JBSWY3DPEHPK3PXP' }, t0 + 5000));
check(
  '跨周期变化',
  totp.code({ secret: 'JBSWY3DPEHPK3PXP' }, t0) !== totp.code({ secret: 'JBSWY3DPEHPK3PXP' }, t0 + 30000),
  'true'
);

console.log('\n倒计时');
check('周期起点剩 30', totp.remainingSeconds({ period: 30 }, 1700000010000), 30);
check('过 1 秒剩 29', totp.remainingSeconds({ period: 30 }, 1700000011000), 29);
check('周期末剩 1', totp.remainingSeconds({ period: 30 }, 1700000039000), 1);

console.log('\nBase32');
check('往返', totp.base32Encode(totp.base32Decode('JBSWY3DPEHPK3PXP')), 'JBSWY3DPEHPK3PXP');
check('容忍空格', h.bytesToHex(totp.base32Decode('jbsw y3dp ehpk 3pxp')), h.bytesToHex(totp.base32Decode('JBSWY3DPEHPK3PXP')));
check('容忍连字符', h.bytesToHex(totp.base32Decode('JBSW-Y3DP-EHPK-3PXP')), h.bytesToHex(totp.base32Decode('JBSWY3DPEHPK3PXP')));
check('容忍小写', h.bytesToHex(totp.base32Decode('jbswy3dpehpk3pxp')), h.bytesToHex(totp.base32Decode('JBSWY3DPEHPK3PXP')));
check('容忍填充', h.bytesToHex(totp.base32Decode('JBSWY3DPEHPK3PXP====')), h.bytesToHex(totp.base32Decode('JBSWY3DPEHPK3PXP')));

console.log('\n错误处理(不能返回假验证码)');
function throws(fn) {
  try { fn(); return false; } catch (e) { return true; }
}
check('空密钥抛错', throws(() => totp.code({ secret: '' })), 'true');
check('纯空格密钥抛错', throws(() => totp.code({ secret: '   ' })), 'true');
check('全非法字符抛错', throws(() => totp.code({ secret: '1890!!!' })), 'true');
check('isValidSecret 空', totp.isValidSecret(''), 'false');
check('isValidSecret 合法', totp.isValidSecret('JBSWY3DPEHPK3PXP'), 'true');

console.log('\notpauth:// 解析');
{
  const t = totp.parseUri('otpauth://totp/GitHub:dev@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=6&period=30');
  check('issuer', t.issuer, 'GitHub');
  check('account', t.accountName, 'dev@example.com');
  check('secret', t.secret, 'JBSWY3DPEHPK3PXP');
  check('digits', t.digits, 6);
  check('period', t.period, 30);
}
{
  // label 里带 issuer 但没有 issuer 参数
  const t = totp.parseUri('otpauth://totp/Google:user@gmail.com?secret=JBSWY3DPEHPK3PXP');
  check('从 label 取 issuer', t.issuer, 'Google');
  check('默认 digits=6', t.digits, 6);
  check('默认 period=30', t.period, 30);
  check('默认 SHA1', t.algorithm, 'SHA1');
}
{
  // URL 编码的中文 issuer + 空格
  const t = totp.parseUri('otpauth://totp/' + encodeURIComponent('支付宝:13800138000') + '?secret=JBSWY3DPEHPK3PXP');
  check('中文 issuer', t.issuer, '支付宝');
  check('中文 account', t.accountName, '13800138000');
}
{
  // 无 issuer,只有账号
  const t = totp.parseUri('otpauth://totp/plainaccount?secret=JBSWY3DPEHPK3PXP');
  check('无 issuer', t.issuer, '');
  check('account', t.accountName, 'plainaccount');
}
{
  // 8 位 + SHA256 + 自定义周期
  const t = totp.parseUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP&digits=8&algorithm=SHA256&period=60');
  check('digits=8', t.digits, 8);
  check('SHA256', t.algorithm, 'SHA256');
  check('period=60', t.period, 60);
}
check('非 otpauth 抛错', throws(() => totp.parseUri('https://example.com')), 'true');
check('缺 secret 抛错', throws(() => totp.parseUri('otpauth://totp/A:b?issuer=A')), 'true');
check('非法 secret 抛错', throws(() => totp.parseUri('otpauth://totp/A:b?secret=!!!!')), 'true');

console.log('\n不支持的输入必须当场拒绝(而不是静默算出一个假验证码)');
{
  // HOTP 是按次数递增的计数器,拿时间去算必然错。以前只校验 scheme,
  // hotp 的码会被当成 totp 收下,用户拿到一个"看着正常但永远对不上"的码。
  const hotpError = (() => {
    try { totp.parseUri('otpauth://hotp/Acme:bob?secret=JBSWY3DPEHPK3PXP&counter=1'); return ''; }
    catch (e) { return e.message; }
  })();
  check('hotp 二维码被拒绝', hotpError.length > 0, 'true');
  check('拒绝原因说清是 HOTP', /HOTP/.test(hotpError), 'true');

  check('未知类型被拒绝', throws(() => totp.parseUri('otpauth://xotp/A:b?secret=JBSWY3DPEHPK3PXP')), 'true');

  // SHA512 以前被静默降级成 SHA1
  check('SHA512 被拒绝', throws(() =>
    totp.parseUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP&algorithm=SHA512')), 'true');
  check('code() 遇到不支持的算法抛错', throws(() =>
    totp.code({ secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA512' })), 'true');

  // 位数同理:显式写了不支持的位数就不能悄悄改成 6
  check('digits=10 被拒绝', throws(() =>
    totp.parseUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP&digits=10')), 'true');
  check('digits=7 被接受', totp.parseUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP&digits=7').digits, 7);
  check('未写 digits 时默认 6', totp.parseUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP').digits, 6);
  check('7 位验证码真的出 7 位',
    totp.code({ secret: 'JBSWY3DPEHPK3PXP', digits: 7 }).length, 7);

  // 大小写不敏感,别把 totp/TOTP 的码拒了
  check('TOTP 大写类型被接受',
    totp.parseUri('otpauth://TOTP/A:b?secret=JBSWY3DPEHPK3PXP').secret, 'JBSWY3DPEHPK3PXP');
}

console.log('\ntoUri 往返');
{
  const original = { issuer: 'GitHub', accountName: 'dev@example.com', secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1' };
  const back = totp.parseUri(totp.toUri(original));
  check('issuer', back.issuer, original.issuer);
  check('account', back.accountName, original.accountName);
  check('secret', back.secret, original.secret);
  check('验证码一致', totp.code(back, t0), totp.code(original, t0));
}
{
  // 带中文和特殊字符的往返
  const original = { issuer: '支付宝 & Co', accountName: 'a+b@例子.com', secret: 'JBSWY3DPEHPK3PXP', digits: 8, period: 60, algorithm: 'SHA256' };
  const back = totp.parseUri(totp.toUri(original));
  check('中文 issuer 往返', back.issuer, original.issuer);
  check('特殊字符 account 往返', back.accountName, original.accountName);
  check('digits 往返', back.digits, original.digits);
  check('period 往返', back.period, original.period);
  check('algorithm 往返', back.algorithm, original.algorithm);
}

console.log(`\n${'='.repeat(46)}`);
console.log(fail === 0 ? `全部通过 (${pass}/${pass})` : `通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
