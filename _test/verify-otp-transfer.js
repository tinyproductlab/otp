const assert = require('assert');
const transfer = require('../utils/otp-transfer.js');

const TOKEN = {
  issuer: 'GitHub',
  accountName: 'eve@example.com',
  secret: 'JBSWY3DPEHPK3PXP',
  digits: 6,
  period: 30,
  algorithm: 'SHA1',
};

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

async function expectsError(name, fn, code) {
  try {
    await fn();
  } catch (error) {
    assert.strictEqual(error.code, code, `${name}: 错误码应为 ${code}，实际为 ${error.code}`);
    passed += 1;
    console.log(`✓ ${name}`);
    return;
  }
  throw new Error(`${name}: 应当抛出错误`);
}

(async () => {
  const now = 1_700_000_000;
  const basic = await transfer.encrypt(TOKEN, 'transfer-123', { nowSeconds: now, expiryMinutes: 15, iterations: 1000 });

  await test('生成 OTPT1 前缀和有效期', async () => {
    assert.ok(basic.payload.startsWith('OTPT1.'));
    const meta = transfer.inspect(basic.payload, { nowSeconds: now + 1 });
    assert.strictEqual(meta.expiresAt, now + 900);
    assert.strictEqual(meta.expired, false);
    assert.ok(meta.payloadLength < transfer.MAX_PAYLOAD_LENGTH);
  });

  await test('正确密码能恢复完整单条 OTP', async () => {
    const decoded = await transfer.decrypt(basic.payload, 'transfer-123', { nowSeconds: now + 100 });
    assert.deepStrictEqual(decoded, Object.assign({ type: 'otp-transfer' }, TOKEN));
  });

  await expectsError('短迁移密码被拒绝', () => transfer.encrypt(TOKEN, 'short', { nowSeconds: now, iterations: 1000 }), 'TRANSFER_PASSWORD');
  await test('6 位迁移密码可正常使用', async () => {
    const sixDigit = await transfer.encrypt(TOKEN, '123456', { nowSeconds: now, expiryMinutes: 15, iterations: 1000 });
    const decoded = await transfer.decrypt(sixDigit.payload, '123456', { nowSeconds: now + 1 });
    assert.strictEqual(decoded.secret, TOKEN.secret);
  });
  await test('仅有效期保护可正常使用', async () => {
    const timeOnly = await transfer.encrypt(TOKEN, '', { nowSeconds: now, expiryMinutes: 5, iterations: 1000 });
    const decoded = await transfer.decrypt(timeOnly.payload, '', { nowSeconds: now + 1 });
    assert.strictEqual(decoded.secret, TOKEN.secret);
  });
  await expectsError('无密码且不设有效期被拒绝', () => transfer.encrypt(TOKEN, '', { nowSeconds: now, expiryMinutes: 0, iterations: 1000 }), 'TRANSFER_PROTECTION');
  await expectsError('错误密码不解密', () => transfer.decrypt(basic.payload, 'wrong-pass', { nowSeconds: now + 10 }), 'TRANSFER_DECRYPT');

  await test('过期状态可预检', async () => {
    const meta = transfer.inspect(basic.payload, { nowSeconds: now + 901 });
    assert.strictEqual(meta.expired, true);
    assert.strictEqual(meta.remainingSeconds, 0);
  });
  await expectsError('过期二维码被拒绝导入', () => transfer.decrypt(basic.payload, 'transfer-123', { nowSeconds: now + 901 }), 'TRANSFER_EXPIRED');

  await test('永不过期二维码可恢复', async () => {
    const permanent = await transfer.encrypt(TOKEN, 'transfer-123', { nowSeconds: now, expiryMinutes: 0, iterations: 1000 });
    const meta = transfer.inspect(permanent.payload, { nowSeconds: now + 10_000_000 });
    assert.strictEqual(meta.permanent, true);
    assert.strictEqual(meta.expired, false);
    const decoded = await transfer.decrypt(permanent.payload, 'transfer-123', { nowSeconds: now + 10_000_000 });
    assert.strictEqual(decoded.secret, TOKEN.secret);
  });

  await expectsError('普通 otpauth 内容不被当作迁移二维码', () => transfer.decrypt('otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP', 'transfer-123', { nowSeconds: now }), 'TRANSFER_FORMAT');

  await test('篡改有效期头部会触发认证失败', async () => {
    const chars = basic.payload.split('');
    const index = chars.length - 2;
    chars[index] = chars[index] === 'A' ? 'B' : 'A';
    await expectsError('篡改二维码', () => transfer.decrypt(chars.join(''), 'transfer-123', { nowSeconds: now + 20 }), 'TRANSFER_DECRYPT');
  });

  await expectsError('非法 OTP 密钥被拒绝', () => transfer.encrypt(Object.assign({}, TOKEN, { secret: '###' }), 'transfer-123', { nowSeconds: now, iterations: 1000 }), 'TRANSFER_TOKEN');
  await expectsError('无效有效期被拒绝', () => transfer.encrypt(TOKEN, 'transfer-123', { nowSeconds: now, expiryMinutes: 2, iterations: 1000 }), 'TRANSFER_EXPIRY');

  // ---- 位数必须如实带走 ----
  // 原来写死 `Number(digits) === 8 ? 8 : 6`,7 位令牌迁移一次就被静默改成 6 位,
  // 到新设备验证码永远对不上,而界面上看不出任何异常。
  await test('7 位令牌往返后仍是 7 位', async () => {
    const seven = Object.assign({}, TOKEN, { digits: 7 });
    const out = await transfer.encrypt(seven, 'transfer-123', { nowSeconds: now, iterations: 1000 });
    const back = await transfer.decrypt(out.payload, 'transfer-123', { nowSeconds: now + 10 });
    assert.strictEqual(back.digits, 7);
  });
  await test('8 位令牌往返后仍是 8 位', async () => {
    const eight = Object.assign({}, TOKEN, { digits: 8 });
    const out = await transfer.encrypt(eight, 'transfer-123', { nowSeconds: now, iterations: 1000 });
    const back = await transfer.decrypt(out.payload, 'transfer-123', { nowSeconds: now + 10 });
    assert.strictEqual(back.digits, 8);
  });
  await expectsError('不支持的位数被拒绝而不是静默改成 6',
    () => transfer.encrypt(Object.assign({}, TOKEN, { digits: 10 }), 'transfer-123', { nowSeconds: now, iterations: 1000 }), 'TRANSFER_TOKEN');
  await expectsError('不支持的算法被拒绝',
    () => transfer.encrypt(Object.assign({}, TOKEN, { algorithm: 'SHA512' }), 'transfer-123', { nowSeconds: now, iterations: 1000 }), 'TRANSFER_TOKEN');

  // ---- 报错要指认是哪一条 ----
  await test('错误信息带上发行商和账号', async () => {
    let message = '';
    try {
      await transfer.encrypt(Object.assign({}, TOKEN, { issuer: 'GitHub', accountName: 'me@x.io', secret: '###' }),
        'transfer-123', { nowSeconds: now, iterations: 1000 });
    } catch (e) { message = e.message; }
    assert.ok(/GitHub/.test(message) && /me@x\.io/.test(message),
      '错误信息里应能看出是哪一条，实际：' + message);
  });

  // ---- 分拣：一条坏的不该毁掉整批 ----
  await test('partitionTokens 把好坏分开', async () => {
    const good1 = Object.assign({}, TOKEN, { issuer: 'A' });
    const good2 = Object.assign({}, TOKEN, { issuer: 'B' });
    const bad = Object.assign({}, TOKEN, { issuer: '坏', secret: '###' });
    const { valid, invalid } = transfer.partitionTokens([good1, bad, good2]);
    assert.strictEqual(valid.length, 2);
    assert.strictEqual(invalid.length, 1);
    assert.strictEqual(invalid[0].label.indexOf('坏'), 0);
    assert.ok(invalid[0].reason.length > 0);
    // 好的那两条仍然能正常加密
    const out = await transfer.encrypt(valid[0], 'transfer-123', { nowSeconds: now, iterations: 1000 });
    assert.ok(out.payload.length > 0);
  });
  await test('全好时 invalid 为空', () => {
    const { valid, invalid } = transfer.partitionTokens([TOKEN, TOKEN]);
    assert.strictEqual(valid.length, 2);
    assert.strictEqual(invalid.length, 0);
  });
  await test('空输入不炸', () => {
    assert.strictEqual(transfer.partitionTokens(null).valid.length, 0);
    assert.strictEqual(transfer.partitionTokens([]).invalid.length, 0);
  });

  console.log(`\nOTP 迁移二维码测试通过：${passed} 项`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
