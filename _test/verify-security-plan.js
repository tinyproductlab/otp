'use strict';

const securityPlan = require('../utils/security-plan.js');

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

function includesSecretKeys(value) {
  const banned = ['password', 'secret', 'account', 'username', 'webdav', 'backupPassword', 'otpUri'];
  return Object.keys(value).some((key) => banned.includes(key));
}

console.log('\n安全画像 —— 脱敏字段');
const now = 1760000000000;
const stats = {
  otpCount: 8,
  passwordCount: 12,
  weakCount: 3,
  duplicateCount: 2,
  webdavConfigured: false,
  lastSyncAt: 0,
};
const snapshot = securityPlan.createSnapshot(stats, {}, now);
check('包含 OTP 数量', snapshot.otpCount, 8);
check('包含弱密码数量', snapshot.weakCount, 3);
check('缺少备份状态', snapshot.backup.status, 'missing');
check('画像不含凭据字段', includesSecretKeys(snapshot), 'false');
check('无同步时间返回 null', snapshot.backup.ageDays, 'null');
check('14 天以内视为近期备份', securityPlan.createSnapshot({ lastSyncAt: now - 14 * securityPlan.DAY }, {}, now).backup.status, 'recent');
check('15 天前视为过期备份', securityPlan.createSnapshot({ lastSyncAt: now - 15 * securityPlan.DAY }, {}, now).backup.status, 'stale');

console.log('\n行动计划 —— 风险排序');
const plan = securityPlan.buildPlan(snapshot);
check('首项优先备份', plan.tasks[0].id, 'backup-first');
check('备份任务为 P0', plan.tasks[0].priority, 'P0');
check('包含重复密码任务', plan.tasks.some((item) => item.id === 'duplicate-passwords'), 'true');
check('包含弱密码任务', plan.tasks.some((item) => item.id === 'weak-passwords'), 'true');
check('行动计划不含凭据字段', plan.tasks.some((item) => includesSecretKeys(item)), 'false');

console.log('\n行动计划 —— 无风险与空状态');
const healthy = securityPlan.buildPlan(securityPlan.createSnapshot({ otpCount: 2, passwordCount: 3, lastSyncAt: now - securityPlan.DAY }, {}, now));
check('无风险展示完成状态', healthy.tasks[0].id, 'keep-it-up');
const empty = securityPlan.buildPlan(securityPlan.createSnapshot({}, {}, now));
check('空状态引导添加验证码', empty.tasks[0].id, 'get-started');

console.log('\n首页建议卡');
const card = securityPlan.buildHomeCard(plan);
check('建议卡默认本地分析', card.label, '智能安全建议 · 本地分析');
check('建议卡显示首项标题', card.title, '备份 8 个验证码');

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
