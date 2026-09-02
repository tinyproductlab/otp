/* 验证 utils/backup.js。运行: node _test/verify-backup.js */
const backup = require('../utils/backup.js');
const h = require('../utils/hash.js');
const crypto = require('crypto');

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

async function rejects(fn) {
  try { await fn(); return false; } catch (e) { return true; }
}

const SNAPSHOT = {
  version: 1,
  passwords: [
    { id: 'a1', title: 'GitHub', site: 'github.com', username: 'dev@example.com', password: 'Gh!tHub#2024', notes: '主账号' },
    { id: 'a2', title: '支付宝', site: 'alipay.com', username: '13800138000', password: 'Zfb@2024!x', notes: '' },
  ],
  otpTokens: [{ id: 'b1', issuer: 'Google', accountName: 'user@gmail.com', secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30 }],
  trash: [],
  settings: { theme: 'system' },
};

(async () => {
  // 测试统一用低迭代数,否则跑一轮要好几秒
  const FAST = { iterations: 2000 };

  console.log('\n容器格式');
  const container = await backup.encrypt(SNAPSHOT, 'my-backup-password', FAST);
  check('是 OTP1 容器', backup.isContainer(container), 'true');
  check('magic', h.bytesToUtf8(container.subarray(0, 4)), 'OTP1');
  check('version', container[4], 1);
  check('头部长度 53', backup.HEADER_LENGTH, 53);
  const header = backup.readHeader(container);
  check('读出迭代数', header.iterations, 2000);
  check('读出版本', header.version, 1);
  check('密文长度 = 总长 - 53', header.payloadLength, container.length - 53);

  console.log('\n往返');
  const restored = await backup.decrypt(container, 'my-backup-password', FAST);
  check('完整往返', JSON.stringify(restored), JSON.stringify(SNAPSHOT));
  check('中文保留', restored.passwords[1].title, '支付宝');
  check('特殊字符保留', restored.passwords[0].password, 'Gh!tHub#2024');

  console.log('\n密码错误 / 篡改');
  check('错密码被拒', await rejects(() => backup.decrypt(container, 'wrong-password', FAST)), 'true');
  check('空密码解普通容器被拒', await rejects(() => backup.decrypt(container, '', FAST)), 'true');
  // 设计已变更:空密码是用户明确确认后的合法配置,是否允许创建由上层配置流程控制(见 utils/backup.js)。
  {
    const emptyPwContainer = await backup.encrypt(SNAPSHOT, '', FAST);
    const emptyPwBack = await backup.decrypt(emptyPwContainer, '', FAST);
    check('空密码加密可用并往返', JSON.stringify(emptyPwBack), JSON.stringify(SNAPSHOT));
  }
  {
    const tampered = container.slice();
    tampered[HEADER_TAMPER_OFFSET()] ^= 1;
    check('篡改密文被拒', await rejects(() => backup.decrypt(tampered, 'my-backup-password', FAST)), 'true');
  }
  {
    // 把迭代数改小(离线爆破的典型手法)—— AAD 必须让它失败
    const tampered = container.slice();
    tampered[5] = 0; tampered[6] = 0; tampered[7] = 0x07; tampered[8] = 0xd0; // 2000 → 2000?不,改成别的
    tampered[8] = 0xd1;
    check('篡改迭代数被拒', await rejects(() => backup.decrypt(tampered, 'my-backup-password', FAST)), 'true');
  }
  {
    const tampered = container.slice();
    tampered[9] ^= 0xff; // 改 salt
    check('篡改 salt 被拒', await rejects(() => backup.decrypt(tampered, 'my-backup-password', FAST)), 'true');
  }
  {
    const tampered = container.slice();
    tampered[25] ^= 0xff; // 改 IV
    check('篡改 IV 被拒', await rejects(() => backup.decrypt(tampered, 'my-backup-password', FAST)), 'true');
  }
  {
    const tampered = container.slice();
    tampered[37] ^= 1; // 改 tag
    check('篡改 tag 被拒', await rejects(() => backup.decrypt(tampered, 'my-backup-password', FAST)), 'true');
  }
  function HEADER_TAMPER_OFFSET() { return 53; }

  console.log('\n格式校验');
  check('非容器被拒', await rejects(() => backup.decrypt(new Uint8Array([1, 2, 3]), 'x', FAST)), 'true');
  check('错 magic 被拒', backup.isContainer(h.utf8ToBytes('XXXX' + 'x'.repeat(60))), 'false');
  check('太短被拒', backup.isContainer(new Uint8Array(10)), 'false');
  {
    // 未来版本必须给出可读提示,而不是崩掉
    const future = container.slice();
    future[4] = 99;
    let message = '';
    try { await backup.decrypt(future, 'my-backup-password', FAST); } catch (e) { message = e.message; }
    check('未来版本给出提示', /不支持的备份版本 v99/.test(message), 'true');
  }
  {
    // 异常迭代数要被挡住,否则手机会被卡死
    const insane = container.slice();
    insane[5] = 0xff; insane[6] = 0xff; insane[7] = 0xff; insane[8] = 0xff;
    let message = '';
    try { await backup.decrypt(insane, 'x', FAST); } catch (e) { message = e.message; }
    check('迭代数过大被挡', /参数异常/.test(message), 'true');
  }

  console.log('\n每次加密都不同(salt/IV 随机)');
  {
    const a = await backup.encrypt(SNAPSHOT, 'same-password', FAST);
    const b = await backup.encrypt(SNAPSHOT, 'same-password', FAST);
    check('两次容器不同', h.bytesToHex(a) !== h.bytesToHex(b), 'true');
    check('但都能解开', JSON.stringify(await backup.decrypt(b, 'same-password', FAST)), JSON.stringify(SNAPSHOT));
  }

  console.log('\nbase64 传输');
  {
    const text = backup.toBase64(container);
    check('是 base64 字符', /^[A-Za-z0-9+/=]+$/.test(text), 'true');
    const back = backup.fromBase64(text);
    check('往返字节一致', h.bytesToHex(back), h.bytesToHex(container));
    // 带换行的 base64(邮件/文本框粘贴常见)
    const wrapped = text.replace(/(.{64})/g, '$1\n');
    check('容忍换行', h.bytesToHex(backup.fromBase64(wrapped)), h.bytesToHex(container));
    check('解密 base64 往返的容器', JSON.stringify(await backup.decrypt(back, 'my-backup-password', FAST)), JSON.stringify(SNAPSHOT));
  }

  console.log('\n进度回调');
  {
    const ratios = [];
    await backup.encrypt(SNAPSHOT, 'pw', { iterations: 10000, onProgress: (r) => ratios.push(r) });
    check('回调被调用', ratios.length > 1, 'true');
    check('单调递增', ratios.every((v, i) => i === 0 || v >= ratios[i - 1]), 'true');
    check('最终到 1', ratios[ratios.length - 1], 1);
    check('范围在 0~1', ratios.every((v) => v > 0 && v <= 1), 'true');
  }

  console.log('\nPBKDF2 分片实现 == 一次性实现');
  {
    // 分片版必须和已验证过的 hash.js 一次性版本逐字节相同
    const password = 'correct horse battery staple';
    const salt = new Uint8Array(crypto.randomBytes(16));
    for (const iterations of [1, 2, 999, 2000, 2001, 5000]) {
      const chunked = await backup._internal.deriveKey(password, salt, iterations);
      const oneShot = h.pbkdf2Sha256(h.utf8ToBytes(password), salt, iterations, 32);
      if (h.bytesToHex(chunked) !== h.bytesToHex(oneShot)) {
        check(`iterations=${iterations}`, h.bytesToHex(chunked), h.bytesToHex(oneShot));
      } else {
        pass++; console.log(`  ✓ iterations=${iterations}`);
      }
    }
  }

  console.log('\n大数据量');
  {
    const big = { passwords: [] };
    for (let i = 0; i < 500; i++) {
      big.passwords.push({ id: 'id' + i, title: '站点' + i, site: `site${i}.com`, username: `user${i}@example.com`, password: crypto.randomBytes(16).toString('base64'), notes: '备注'.repeat(10) });
    }
    const start = Date.now();
    const bigContainer = await backup.encrypt(big, 'pw', FAST);
    const elapsed = Date.now() - start;
    console.log(`  500 条记录 (${(bigContainer.length / 1024).toFixed(1)} KB) 加密 ${elapsed} ms`);
    const bigBack = await backup.decrypt(bigContainer, 'pw', FAST);
    check('500 条往返一致', bigBack.passwords.length, 500);
    check('内容逐条一致', JSON.stringify(bigBack) === JSON.stringify(big), 'true');
  }

  console.log('\n文件名');
  check('格式', /^OTPLAB_\d{8}_\d{6}\.bak$/.test(backup.suggestFilename(new Date(2026, 7, 20, 14, 30, 5))), 'true');
  check('具体值', backup.suggestFilename(new Date(2026, 7, 20, 14, 30, 5)), 'OTPLAB_20260820_143005.bak');

  console.log(`\n${'='.repeat(46)}`);
  console.log(fail === 0 ? `全部通过 (${pass}/${pass})` : `通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
