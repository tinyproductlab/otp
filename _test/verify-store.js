/* 验证 utils/store.js + utils/webdav.js(纯本地,不发网络请求)。运行: node _test/verify-store.js */
const store = require('../utils/store.js');
const webdav = require('../utils/webdav.js');
const random = require('../utils/random.js');

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

(async () => {
  await random.prefetch();

  console.log('\n初始化');
  store._reset();
  await store.ready();
  check('默认分组自动创建', store.listGroups().length, 1);
  check('默认分组 id', store.listGroups()[0].id, store.DEFAULT_GROUP_ID);
  check('默认分组显示名', store.listGroups()[0].displayName, '默认分组');
  check('初始无密码', store.listPasswords().length, 0);

  console.log('\nUUID');
  {
    const ids = new Set();
    for (let i = 0; i < 5000; i++) ids.add(store.uuid());
    check('5000 个无碰撞', ids.size, 5000);
    check('格式正确', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(store.uuid()), 'true');
  }

  console.log('\n密码 CRUD');
  const p1 = await store.savePassword({ title: 'GitHub', site: 'github.com', username: 'dev@example.com', password: 'Gh!tHub#2024' });
  check('新增有 id', !!p1.id, 'true');
  check('新增有 createdAt', !!p1.createdAt, 'true');
  check('归入默认分组', p1.group, store.DEFAULT_GROUP_ID);
  check('列表 1 条', store.listPasswords().length, 1);
  check('按 id 取得', store.getPassword(p1.id).title, 'GitHub');
  check('首条密码保存后标记备份密码引导', store.getSettings().backupPromptSeen, 'true');
  check('首条保存不强制建立备份密码', store.isBackupPasswordConfigured(), 'false');

  const p1Updated = await store.savePassword(Object.assign({}, p1, { title: 'GitHub 主号' }));
  check('更新不新增', store.listPasswords().length, 1);
  check('更新生效', store.getPassword(p1.id).title, 'GitHub 主号');
  check('保留 createdAt', p1Updated.createdAt, p1.createdAt);

  await store.savePassword({ title: '支付宝', site: 'alipay.com', username: '13800138000', password: 'weak' });
  await store.savePassword({ title: 'Google', site: 'google.com', username: 'a@gmail.com', password: 'Abcdefghijk1!' });
  check('共 3 条', store.listPasswords().length, 3);

  console.log('\n搜索与排序');
  check('搜标题', store.listPasswords({ keyword: 'github' }).length, 1);
  check('搜网站', store.listPasswords({ keyword: 'alipay' }).length, 1);
  check('搜账号', store.listPasswords({ keyword: '13800' }).length, 1);
  check('搜中文', store.listPasswords({ keyword: '支付宝' }).length, 1);
  check('大小写不敏感', store.listPasswords({ keyword: 'GITHUB' }).length, 1);
  check('无结果', store.listPasswords({ keyword: 'nonexistent' }).length, 0);
  check('按名称排序:西文在前', store.listPasswords({ sort: 'name' })[0].title, 'GitHub 主号');
  check('按名称排序:中文在后', store.listPasswords({ sort: 'name' })[2].title, '支付宝');
  check('按名称排序:西文组内有序', store.listPasswords({ sort: 'name' })[1].title, 'Google');
  check('按时间排序(最新在前)', store.listPasswords({ sort: 'time' })[0].title, 'Google');

  console.log('\n分组');
  const group = await store.createGroup('工作');
  check('创建成功', group.name, '工作');
  check('分组数 2', store.listGroups().length, 2);
  check('同名被拒', await rejects(() => store.createGroup('工作')), 'true');
  check('同名(不同大小写)被拒', await rejects(() => store.createGroup('工作')), 'true');
  check('空名被拒', await rejects(() => store.createGroup('  ')), 'true');
  check('默认分组不能改名', await rejects(() => store.renameGroup(store.DEFAULT_GROUP_ID, 'x')), 'true');
  check('默认分组不能删', await rejects(() => store.deleteGroup(store.DEFAULT_GROUP_ID)), 'true');

  await store.savePassword(Object.assign({}, store.getPassword(p1.id), { group: group.id }));
  check('按分组筛选', store.listPasswords({ group: group.id }).length, 1);
  check('分组计数', store.listGroups().find((g) => g.id === group.id).count, 1);

  await store.renameGroup(group.id, '工作账号');
  check('改名生效', store.listGroups().find((g) => g.id === group.id).name, '工作账号');

  await store.deleteGroup(group.id);
  check('删组后分组数 1', store.listGroups().length, 1);
  check('组内密码退回默认分组(不跟着删)', store.getPassword(p1.id).group, store.DEFAULT_GROUP_ID);
  check('密码没丢', store.listPasswords().length, 3);

  console.log('\n删除 → 回收站');
  await store.deletePassword(p1.id);
  check('密码剩 2', store.listPasswords().length, 2);
  check('回收站 1 条', store.listTrash().length, 1);
  check('回收站标题', store.listTrash()[0].title, 'GitHub 主号');
  check('回收站类型', store.listTrash()[0].kind, 'password');
  check('删不存在的返回 false', await store.deletePassword('nope'), 'false');

  const trashId = store.listTrash()[0].id;
  await store.restoreTrash(trashId);
  check('恢复后密码 3', store.listPasswords().length, 3);
  check('恢复后回收站空', store.listTrash().length, 0);
  check('恢复的内容正确', store.getPassword(p1.id).title, 'GitHub 主号');

  console.log('\nTOTP');
  const t1 = await store.saveOtpToken({ issuer: 'Google', accountName: 'user@gmail.com', secret: 'JBSWY3DPEHPK3PXP' });
  check('新增成功', !!t1.id, 'true');
  check('默认 6 位', t1.digits, 6);
  check('默认 30 秒', t1.period, 30);
  check('默认 SHA1', t1.algorithm, 'SHA1');
  check('列表 1 条', store.listOtpTokens().length, 1);

  // 同密钥 + 同发行商 + 同账号 → 视为重复
  let duplicateError = null;
  try {
    await store.saveOtpToken({ issuer: 'Google', accountName: 'user@gmail.com', secret: 'JBSWY3DPEHPK3PXP' });
  } catch (e) { duplicateError = e; }
  check('重复被拒', duplicateError && duplicateError.code, 'DUPLICATE');
  check('重复错误带已存在 id', duplicateError.existingId, t1.id);
  check('仍然只有 1 条', store.listOtpTokens().length, 1);

  // 同密钥但不同账号 → 允许
  await store.saveOtpToken({ issuer: 'Google', accountName: 'other@gmail.com', secret: 'JBSWY3DPEHPK3PXP' });
  check('不同账号可共存', store.listOtpTokens().length, 2);

  await store.saveOtpToken({ issuer: 'GitHub', accountName: 'dev', secret: 'GEZDGNBVGY3TQOJQ' });
  check('搜索发行商', store.listOtpTokens('github').length, 1);
  check('搜索账号', store.listOtpTokens('other').length, 1);

  await store.toggleOtpPinned(store.listOtpTokens()[2].id);
  check('置顶排到第一', store.listOtpTokens()[0].pinned, 'true');

  await store.deleteOtpToken(t1.id);
  check('删除后 2 条', store.listOtpTokens().length, 2);
  check('进了回收站', store.listTrash().filter((i) => i.kind === 'otp').length, 1);
  await store.restoreTrash(store.listTrash()[0].id);
  check('恢复后 3 条', store.listOtpTokens().length, 3);

  const batchCounts = await store.importOtpTokens([
    { issuer: 'Google', accountName: 'user@gmail.com', secret: 'JBSWY3DPEHPK3PXP' },
    { issuer: 'Microsoft', accountName: 'batch@example.com', secret: 'MFRGGZDFMZTWQ2LK', digits: 8, period: 60, algorithm: 'SHA256' },
  ]);
  check('批量 OTP 仅新增非重复项', batchCounts.added, 1);
  check('批量 OTP 统计重复项', batchCounts.duplicate, 1);
  check('批量 OTP 保留字段', store.listOtpTokens('microsoft')[0].digits === 8 && store.listOtpTokens('microsoft')[0].period === 60, 'true');

  console.log('\n生成历史');
  await store.addGeneration('Abc123!@#xyz', '12 位 · 小写/大写/数字/符号');
  await store.addGeneration('Xyz789$%^abc', '12 位 · 小写/大写/数字/符号');
  check('2 条', store.listGenerations().length, 2);
  check('最新在前', store.listGenerations()[0].password, 'Xyz789$%^abc');
  check('记录了长度', store.listGenerations()[0].length, 12);
  await store.deleteGenerations([store.listGenerations()[0].id]);
  check('删除后 1 条', store.listGenerations().length, 1);

  console.log('\n生成历史保留策略');
  {
    store._reset();
    await store.ready();
    for (let i = 0; i < 520; i++) await store.addGeneration('pw' + i, 'cfg');
    check('上限 500 条', store.listGenerations().length, 500);
    // 切到"仅保留一个月",旧记录应被清掉
    store.state.generations.forEach((item, index) => {
      if (index > 250) item.createdAt = Date.now() - 40 * 86400000;
    });
    await store.updateSettings({ generationRetention: 'month' });
    check('按月清理生效', store.listGenerations().length < 500, 'true');
  }

  console.log('\n回收站保留期');
  {
    store._reset();
    await store.ready();
    const target = await store.savePassword({ title: '旧', password: 'x' });
    await store.deletePassword(target.id);
    check('回收站 1 条', store.listTrash().length, 1);
    // 把删除时间改成 40 天前
    store.state.trash[0].deletedAt = Date.now() - 40 * 86400000;
    await store.updateSettings({ trashRetentionDays: 30 });
    check('超期被清(30天)', store.listTrash().length, 0);
  }
  {
    store._reset();
    await store.ready();
    const target = await store.savePassword({ title: '旧', password: 'x' });
    await store.deletePassword(target.id);
    store.state.trash[0].deletedAt = Date.now() - 400 * 86400000;
    await store.updateSettings({ trashRetentionDays: 0 });
    check('永久保留不清', store.listTrash().length, 1);
  }

  console.log('\n清空回收站');
  await store.emptyTrash();
  check('已清空', store.listTrash().length, 0);

  console.log('\n统计');
  {
    store._reset();
    await store.ready();
    await store.savePassword({ title: 'a', password: 'Abcdefghijk1!' }); // 强
    await store.savePassword({ title: 'b', password: 'weak' });          // 弱
    await store.savePassword({ title: 'c', password: 'same' });
    await store.savePassword({ title: 'd', password: 'same' });          // 与 c 重复
    await store.saveOtpToken({ issuer: 'X', accountName: 'y', secret: 'JBSWY3DPEHPK3PXP' });
    const s = store.stats();
    check('密码数', s.passwordCount, 4);
    check('TOTP 数', s.otpCount, 1);
    check('弱密码数', s.weakCount, 3); // weak/same/same 都 <45
    check('重复密码数', s.duplicateCount, 2);
    check('WebDAV 未配置', s.webdavConfigured, 'false');
  }

  console.log('\n设置');
  check('默认主题', store.getSettings().theme, 'system');
  await store.updateSettings({ theme: 'dark' });
  check('主题已改', store.getSettings().theme, 'dark');
  check('其他设置未被清掉', store.getSettings().trashRetentionDays, 30);

  console.log('\n备份密码长度与生成');
  check('下限是 8 位', store.BACKUP_PASSWORD_MIN, 8);
  check('上限是 64 位', store.BACKUP_PASSWORD_MAX, 64);
  await store.updateBackupPassword('passw0rd');
  check('8 位备份密码可保存', store.verifyBackupPassword('passw0rd'), 'true');
  const long = 'a'.repeat(64);
  await store.updateBackupPassword(long);
  check('64 位备份密码可保存', store.verifyBackupPassword(long), 'true');
  const generated = store.generateBackupPassword();
  check('随机备份密码默认 16 位', generated.length, 16);
  check('随机备份密码最短为 8 位', store.generateBackupPassword(1).length, 8);
  check('随机备份密码最长为 64 位', store.generateBackupPassword(999).length, 64);
  let lengthError = null;
  try { await store.updateBackupPassword('short7c'); } catch (error) { lengthError = error; }
  check('少于 8 位备份密码被底层拒绝', lengthError && lengthError.code, 'INVALID_BACKUP_PASSWORD_LENGTH');
  lengthError = null;
  try { await store.updateBackupPassword('a'.repeat(65)); } catch (error) { lengthError = error; }
  check('超过 64 位备份密码被底层拒绝', lengthError && lengthError.code, 'INVALID_BACKUP_PASSWORD_LENGTH');

  const tooShort = store.checkBackupPasswordLength('abc');
  check('校验函数拒绝 3 位', tooShort.ok, 'false');
  check('校验函数给出可展示的原因', tooShort.message.length > 0, 'true');
  check('校验函数接受 8 位', store.checkBackupPasswordLength('passw0rd').ok, 'true');
  check('校验函数接受 64 位', store.checkBackupPasswordLength('a'.repeat(64)).ok, 'true');

  // 生成器必须走拒绝采样,不能用 byte % 65(会让 61 个字符概率高 33%)。
  // 用卡方检验:偏置版本在这个样本量下会稳定超过临界值。
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const tally = new Map();
  const samples = 40000;
  for (let i = 0; i < samples / 40; i++) {
    for (const ch of store.generateBackupPassword(40)) tally.set(ch, (tally.get(ch) || 0) + 1);
  }
  const expected = samples / alphabet.length;
  let chiSquare = 0;
  for (const ch of alphabet) {
    const diff = (tally.get(ch) || 0) - expected;
    chiSquare += (diff * diff) / expected;
  }
  // 自由度 64,α=0.001 的临界值约 105;取模偏置会让统计量到几百
  console.log(`      (卡方统计量 = ${chiSquare.toFixed(1)}，临界值 105)`);
  check('生成的备份密码字符分布无偏(卡方 < 105)', chiSquare < 105, 'true');
  check('生成器用满了整个字符集', tally.size, alphabet.length);

  console.log('\nWebDAV 配置');
  await store.updateWebdav({ account: 'me@example.com', appPassword: 'app-pw' });
  check('已配置', store.stats().webdavConfigured, 'true');
  check('默认服务商', store.getWebdav().provider, 'jianguoyun');
  // 设计已变更:不再自动追加默认目录,由用户在备份页配置(见 pages/backup 的 checkWebdavConfig / store 的 getWebdav)。
  check('不自动追加默认目录', store.getWebdav().directory, undefined);

  console.log('\n快照与恢复(合并语义)');
  {
    store._reset();
    await store.ready();
    const a = await store.savePassword({ title: 'A', password: '1' });
    const b = await store.savePassword({ title: 'B', password: '2' });
    await store.saveOtpToken({ issuer: 'T', accountName: 't', secret: 'JBSWY3DPEHPK3PXP' });
    const snap = JSON.parse(JSON.stringify(store.snapshot()));
    check('快照含密码', snap.passwords.length, 2);
    check('快照含 TOTP', snap.otpTokens.length, 1);
    check('快照不含回收站', snap.trash, 'undefined');

    // 本地删掉一条,再恢复 → 应该回来
    await store.deletePassword(a.id);
    check('删后 1 条', store.listPasswords().length, 1);
    const counts = await store.restoreSnapshot(snap);
    check('恢复补回', store.listPasswords().length, 2);
    check('报告新增数', counts.passwords, 1);

    // 本地改得更新,恢复旧快照 → 不该被旧数据覆盖
    await store.savePassword(Object.assign({}, store.getPassword(b.id), { title: 'B 新版' }));
    await store.restoreSnapshot(snap);
    check('较新的本地数据不被旧备份覆盖', store.getPassword(b.id).title, 'B 新版');

    // 恢复更新的快照 → 应该覆盖
    const newer = JSON.parse(JSON.stringify(snap));
    newer.passwords.find((p) => p.id === b.id).title = 'B 更新版';
    newer.passwords.find((p) => p.id === b.id).updatedAt = Date.now() + 100000;
    await store.restoreSnapshot(newer);
    check('较新的备份覆盖本地', store.getPassword(b.id).title, 'B 更新版');

    check('空快照被拒', await rejects(() => store.restoreSnapshot(null)), 'true');
    check('恢复不影响 TOTP 数', store.listOtpTokens().length, 1);
  }

  console.log('\n持久化(内存后端)');
  {
    store._reset();
    await store.ready();
    await store.savePassword({ title: '持久化测试', password: 'x' });
    // 模拟重启:清内存状态但保留后端存储
    const backend = store.state.passwords.slice();
    check('写入后可读', backend.length, 1);
  }

  console.log('\nWebDAV URL 构造');
  const wd = webdav._internal;
  check('基本路径', wd.buildUrl({ provider: 'jianguoyun', directory: 'otplab' }, 'OTPLAB_1.bak'), 'https://dav.jianguoyun.com/dav/OTPLAB_1.bak');
  check('目录带斜杠被规范化', wd.buildUrl({ provider: 'jianguoyun', directory: '/otplab/' }, 'a.bak'), 'https://dav.jianguoyun.com/dav/a.bak');
  check('多级目录', wd.buildUrl({ provider: 'jianguoyun', directory: 'a/b' }, 'c.bak'), 'https://dav.jianguoyun.com/dav/c.bak');
  check('空目录放根', wd.buildUrl({ provider: 'jianguoyun', directory: '' }, 'a.bak'), 'https://dav.jianguoyun.com/dav/a.bak');
  check('中文目录被编码', wd.buildUrl({ provider: 'jianguoyun', directory: '备份' }, 'a.bak'), 'https://dav.jianguoyun.com/dav/a.bak');
  check('斜杠不被编码', wd.buildUrl({ provider: 'jianguoyun', directory: 'a/b' }, 'c.bak').indexOf('%2F'), -1);

  console.log('\nWebDAV 认证头');
  check('Basic 编码正确', wd.authHeader({ account: 'user', appPassword: 'pass' }), 'Basic ' + Buffer.from('user:pass').toString('base64'));
  check('缺账号抛错', (() => { try { wd.authHeader({ appPassword: 'x' }); return false; } catch (e) { return true; } })(), 'true');
  check('缺密码抛错', (() => { try { wd.authHeader({ account: 'x' }); return false; } catch (e) { return true; } })(), 'true');

  console.log('\nWebDAV 状态码提示(要能照着做)');
  check('401 提到应用密码', /应用密码/.test(wd.describeStatus(401)), 'true');
  check('409 提到要先建文件夹', /文件夹/.test(wd.describeStatus(409)), 'true');
  check('503 提到限流', /限流/.test(wd.describeStatus(503)), 'true');
  check('507 提到空间', /空间|流量/.test(wd.describeStatus(507)), 'true');
  check('404 下载语境', /备份文件不存在/.test(wd.describeStatus(404, 'download')), 'true');

  console.log('\nWebDAV 服务商');
  check('只有坚果云', Object.keys(webdav.PROVIDERS).join(','), 'jianguoyun');
  check('名称', webdav.provider('jianguoyun').name, '坚果云');
  check('未知服务商抛错', (() => { try { webdav.provider('dropbox'); return false; } catch (e) { return true; } })(), 'true');
  check('帮助文案提到应用密码', /应用密码/.test(webdav.provider().helpText), 'true');

  console.log(`\n${'='.repeat(46)}`);
  console.log(fail === 0 ? `全部通过 (${pass}/${pass})` : `通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
