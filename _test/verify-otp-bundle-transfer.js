const bundle = require('../utils/otp-bundle-transfer.js');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
}

async function expectError(name, fn, code) {
  try {
    await fn();
    check(name, false, '未抛出错误');
  } catch (error) {
    check(name, !code || error.code === code, `${error.code || '无代码'} / ${error.message}`);
  }
}

function tokens(count) {
  return Array.from({ length: count }, (_, index) => ({
    issuer: `Service ${index + 1}`,
    accountName: `user${index + 1}@example.com`,
    secret: 'JBSWY3DPEHPK3PXP',
    digits: index % 2 ? 8 : 6,
    period: index % 3 ? 30 : 60,
    algorithm: index % 2 ? 'SHA256' : 'SHA1',
  }));
}

(async () => {
  const options = { nowSeconds: 1700000000, expiryMinutes: 15, iterations: 2000 };
  const result = await bundle.encrypt(tokens(20), '123456', options);
  check('全量 OTP 自动拆成多张二维码', result.total > 1 && result.payloads.length === result.total, String(result.total));
  check('每张二维码识别为全量迁移协议', result.payloads.every(bundle.isBundlePayload));
  check('每张二维码长度控制在可扫范围', result.payloads.every((payload) => payload.length < 760));

  const restored = await bundle.decrypt(result.payloads.slice().reverse(), '123456', { nowSeconds: 1700000001, iterations: 2000 });
  check('分片乱序仍可正确解密', restored.tokens.length === 20);
  check('OTP 字段完整保留', restored.tokens[1].digits === 8 && restored.tokens[0].period === 60 && restored.tokens[1].algorithm === 'SHA256');

  const inspected = bundle.inspect(result.payloads, { nowSeconds: 1700000001 });
  check('完整分片可读取有效期', inspected.total === result.total && !inspected.expired && inspected.expiresAt === 1700000900);

  await expectError('缺少分片拒绝导入', () => bundle.decrypt(result.payloads.slice(1), '123456', { nowSeconds: 1700000001 }), 'BUNDLE_INCOMPLETE');
  await expectError('错误密码拒绝导入', () => bundle.decrypt(result.payloads, '654321', { nowSeconds: 1700000001 }), 'BUNDLE_DECRYPT');
  await expectError('到期二维码拒绝导入', () => bundle.decrypt(result.payloads, '123456', { nowSeconds: 1700000900 }), 'BUNDLE_EXPIRED');

  const other = await bundle.encrypt(tokens(2), '123456', options);
  await expectError('混入其他会话分片会拒绝', () => bundle.decrypt([result.payloads[0], other.payloads[0]], '123456', { nowSeconds: 1700000001 }), 'BUNDLE_INCOMPLETE');
  await expectError('过短密码被拒绝', () => bundle.encrypt(tokens(1), '12345', options), 'TRANSFER_PASSWORD');
  await expectError('无密码且永不过期被拒绝', () => bundle.encrypt(tokens(1), '', { nowSeconds: 1700000000, expiryMinutes: 0, iterations: 2000 }), 'BUNDLE_PROTECTION');

  const timeOnly = await bundle.encrypt(tokens(1), '', { nowSeconds: 1700000000, expiryMinutes: 5, iterations: 2000 });
  const timeOnlyRestored = await bundle.decrypt(timeOnly.payloads, '', { nowSeconds: 1700000001 });
  check('仅有效期保护可导入', timeOnlyRestored.tokens.length === 1);

  const tampered = result.payloads.slice();
  const changedAt = tampered[0].length - 8;
  const changedChar = tampered[0].charAt(changedAt);
  tampered[0] = tampered[0].slice(0, changedAt) + (changedChar === 'A' ? 'B' : 'A') + tampered[0].slice(changedAt + 1);
  await expectError('篡改任意分片会拒绝', () => bundle.decrypt(tampered, '123456', { nowSeconds: 1700000001 }), 'BUNDLE_DECRYPT');

  if (failed) {
    console.error(`全量 OTP 迁移二维码测试失败：${passed} 项通过，${failed} 项失败`);
    process.exit(1);
  }
  console.log(`全量 OTP 迁移二维码测试通过：${passed} 项`);
})();
