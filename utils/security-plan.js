'use strict';

/**
 * 本地安全行动计划。
 *
 * 本模块只接收 store.stats() 与 WebDAV 的同步时间等聚合状态，故意不读取密码、
 * TOTP 密钥、账号、备注、备份口令或 WebDAV 凭据。将来接入 AI 服务时，也只能发送
 * createSnapshot() 的返回值，不能绕过这里传原始 store 数据。
 */

const DAY = 24 * 60 * 60 * 1000;

function normalizeNonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function daysSince(timestamp, now = Date.now()) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.max(0, Math.floor((now - value) / DAY));
}

/**
 * 仅包含不可逆的计数、枚举与时间段；可作为未来受控 AI 请求的唯一 payload。
 */
function createSnapshot(stats = {}, webdav = {}, now = Date.now()) {
  const otpCount = normalizeNonNegativeInt(stats.otpCount);
  const passwordCount = normalizeNonNegativeInt(stats.passwordCount);
  const weakCount = normalizeNonNegativeInt(stats.weakCount);
  const duplicateCount = normalizeNonNegativeInt(stats.duplicateCount);
  const lastBackupAt = Number(stats.lastSyncAt || webdav.lastSyncAt || 0) || null;
  const backupAgeDays = daysSince(lastBackupAt, now);

  return {
    version: 1,
    generatedAt: now,
    otpCount,
    passwordCount,
    weakCount,
    duplicateCount,
    backup: {
      configured: Boolean(stats.webdavConfigured),
      hasBackup: backupAgeDays !== null,
      ageDays: backupAgeDays,
      status: backupAgeDays === null ? 'missing' : backupAgeDays > 14 ? 'stale' : 'recent',
    },
  };
}

function task(id, priority, title, description, actionLabel, action, tone) {
  return { id, priority, title, description, actionLabel, action, tone, done: false };
}

/**
 * 用确定性规则生成行动卡。它是当前不依赖第三方服务的 P0 实现，也给后续 AI
 * 建议提供安全、稳定的 baseline：AI 只能改写解释或排序，不能生成额外执行动作。
 */
function buildPlan(snapshot = {}) {
  const otpCount = normalizeNonNegativeInt(snapshot.otpCount);
  const passwordCount = normalizeNonNegativeInt(snapshot.passwordCount);
  const weakCount = normalizeNonNegativeInt(snapshot.weakCount);
  const duplicateCount = normalizeNonNegativeInt(snapshot.duplicateCount);
  const backup = snapshot.backup || {};
  const tasks = [];

  if (otpCount > 0 && backup.status === 'missing') {
    tasks.push(task(
      'backup-first',
      'P0',
      `备份 ${otpCount} 个验证码`,
      '换机、清缓存或掉登录态时，备份是恢复两步验证码的重要保障。备份口令只由你保管。',
      '打开本地备份',
      'backup-local',
      'blue'
    ));
  } else if (otpCount > 0 && backup.status === 'stale') {
    tasks.push(task(
      'backup-refresh',
      'P0',
      `更新 ${backup.ageDays} 天前的备份`,
      `你保存了 ${otpCount} 个验证码；建议在设备更换或数据变化后重新创建加密备份。`,
      '更新本地备份',
      'backup-local',
      'blue'
    ));
  }

  if (duplicateCount > 0) {
    tasks.push(task(
      'duplicate-passwords',
      'P1',
      `处理 ${duplicateCount} 个重复密码`,
      '同一密码被多个账号使用时，一个站点泄露可能影响其他账号。请逐个替换，不要一次性改完后忘记保存。',
      '查看重复密码',
      'password-duplicate',
      'orange'
    ));
  }

  if (weakCount > 0) {
    tasks.push(task(
      'weak-passwords',
      'P1',
      `升级 ${weakCount} 个较弱密码`,
      '使用本地密码生成器创建更长、更多样的随机密码，再保存到静态密码账本。',
      '查看较弱密码',
      'password-weak',
      'red'
    ));
  }

  if (tasks.length === 0 && (otpCount > 0 || passwordCount > 0)) {
    tasks.push(task(
      'keep-it-up',
      '完成',
      '当前安全状态良好',
      '未发现需要优先处理的弱密码、重复密码或过期备份。建议在新增验证码或更换设备前再检查一次。',
      '查看数据管理',
      'backup-home',
      'green'
    ));
  }

  if (tasks.length === 0) {
    tasks.push(task(
      'get-started',
      '开始使用',
      '先添加验证码或密码',
      '保存少量数据后，小程序才能根据本地安全状态提供行动建议。',
      '添加验证码',
      'add-otp',
      'purple'
    ));
  }

  const priorityWeight = { P0: 0, P1: 1, P2: 2, '完成': 3, '开始使用': 4 };
  tasks.sort((left, right) => (priorityWeight[left.priority] ?? 9) - (priorityWeight[right.priority] ?? 9));

  return {
    source: 'local',
    title: tasks[0].title,
    summary: tasks[0].description,
    total: tasks.length,
    completed: tasks[0].priority === '完成' ? tasks.length : 0,
    tasks,
  };
}

function buildHomeCard(plan = {}) {
  const first = (plan.tasks || [])[0];
  if (!first) {
    return { visible: false, tone: 'blue', label: '', title: '', summary: '', actionLabel: '' };
  }
  return {
    visible: true,
    tone: first.tone || 'blue',
    label: plan.source === 'local' ? '智能安全建议 · 本地分析' : 'AI 安全建议 · 脱敏分析',
    title: first.title,
    summary: first.description,
    actionLabel: plan.total > 1 ? `查看 ${plan.total} 项安全行动` : first.actionLabel,
  };
}

module.exports = {
  DAY,
  daysSince,
  createSnapshot,
  buildPlan,
  buildHomeCard,
};
