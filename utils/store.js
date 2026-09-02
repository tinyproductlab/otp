/**
 * 数据层
 *
 * 两个平台约束决定了这里的设计:
 *   1. `encrypt: true` **只有异步版 wx.setStorage 支持**(同步版没有这个选项),
 *      所以读写必须是异步的。内存里保留一份作为即时读取的来源。
 *   2. 单键上限 1MB、总量 10MB。所以按集合分键存,而不是一个大 JSON ——
 *      既避开单键上限,也避免改一条密码就重写整个库。
 *
 * ⚠️ encrypt 的密钥由微信托管、绑定 openid + 设备。换设备、清缓存、掉登录态
 *    都可能丢数据。所以"导出备份"不是附属功能,而是唯一的数据保险。
 */

const KEYS = {
  passwords: 'ks_passwords',
  passwordGroups: 'ks_password_groups',
  otpTokens: 'ks_otp_tokens',
  generations: 'ks_generations',
  trash: 'ks_trash',
  settings: 'ks_settings',
  webdav: 'ks_webdav',
  qrHistory: 'ks_qr_history',
  backupSecret: 'ks_backup_secret',
  backupConfigured: 'ks_backup_configured',
};

const DEFAULT_GROUP_ID = '00000000-0000-0000-0000-000000000000';

/**
 * 备份密码策略。
 *
 * 为什么最少 8 位:备份文件里是全部密码和 OTP 密钥,而它离开设备之后
 * 就只剩这个密码在保护它。PBKDF2 120000 次能把在线试错拖慢,但挡不住
 * 拿到文件后离线跑 GPU —— 4 位纯数字只有 1 万种组合,那是分钟级的事。
 * 原来的下限 4 位对"顺手设一个"太友好,对"文件泄露"太友好。
 *
 * 上限从 16 提到 64:密码只作为 KDF 输入,长度不影响任何格式,
 * 没有理由拦着愿意用长口令的用户。
 */
const BACKUP_PASSWORD_MIN = 8;
const BACKUP_PASSWORD_MAX = 64;
const BACKUP_PASSWORD_RULE = `${BACKUP_PASSWORD_MIN}–${BACKUP_PASSWORD_MAX} 位`;

/**
 * 校验备份密码长度。
 * @returns {{ok: boolean, message: string}} ok 为 false 时 message 可直接展示
 */
function checkBackupPasswordLength(value) {
  const text = String(value == null ? '' : value);
  if (text.length < BACKUP_PASSWORD_MIN) {
    return { ok: false, message: `备份密码至少 ${BACKUP_PASSWORD_MIN} 位` };
  }
  if (text.length > BACKUP_PASSWORD_MAX) {
    return { ok: false, message: `备份密码最多 ${BACKUP_PASSWORD_MAX} 位` };
  }
  return { ok: true, message: '' };
}

const DEFAULT_SETTINGS = {
  theme: 'system', // system | light | dark
  // system | zh-Hans | en | ja | zh-Hant
  // 语言偏好属于本机界面设置，不跟随备份恢复到新设备。
  locale: 'system',
  trashRetentionDays: 30, // 7 | 30 | 90 | 0(永久)
  generationRetention: '500', // '500' | 'month'
  clipboardHint: true, // 复制后提示"请尽快粘贴"
  biometricLock: false, // 使用指纹或面容锁定小程序(唯一的锁定开关)
  backupPromptSeen: false, // 第一条 OTP/密码保存后是否已展示过备份密码引导
};

const DEFAULT_WEBDAV = {
  provider: 'jianguoyun',
  url: 'https://dav.jianguoyun.com/dav',
  account: '',
  appPassword: '',
  lastSyncAt: 0,
  lastBackupName: '',
};

// ---- 存储适配:小程序用 wx,测试环境退化为内存 ----

const memoryFallback = new Map();

function hasWx() {
  return typeof wx !== 'undefined' && wx.setStorage && wx.getStorage;
}

function readKey(key) {
  return new Promise((resolve) => {
    if (!hasWx()) {
      resolve(memoryFallback.has(key) ? memoryFallback.get(key) : null);
      return;
    }
    wx.getStorage({
      key,
      encrypt: true,
      success: (res) => resolve(res.data),
      // 读不到分两种:没存过(正常),或解密失败(换设备了)。都当成空,交由上层提示。
      fail: () => resolve(null),
    });
  });
}

function writeKey(key, value) {
  return new Promise((resolve, reject) => {
    if (!hasWx()) {
      memoryFallback.set(key, value);
      resolve();
      return;
    }
    wx.setStorage({
      key,
      data: value,
      encrypt: true,
      success: () => resolve(),
      fail: (err) => reject(new Error('保存失败: ' + (err && err.errMsg ? err.errMsg : '未知错误'))),
    });
  });
}

// ---- 内存状态 ----

const state = {
  passwords: [],
  passwordGroups: [],
  otpTokens: [],
  generations: [],
  trash: [],
  settings: Object.assign({}, DEFAULT_SETTINGS),
  webdav: Object.assign({}, DEFAULT_WEBDAV),
  qrHistory: [],
  backupSecret: '',
  backupConfigured: false,
};

let loaded = false;
let loading = null;
let loadError = null;
let backupPrompted = false;
const listeners = new Set();

function notify() {
  listeners.forEach((fn) => {
    try { fn(state); } catch (e) { /* 单个监听者出错不影响其他 */ }
  });
}

/** 订阅数据变化,返回取消订阅函数 */
function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function nowMs() {
  return Date.now();
}

function ensureBackupPassword() {
  if (state.backupConfigured) return Promise.resolve(state.backupSecret);
  if (typeof wx === 'undefined' || !wx.showModal) {
    const error = new Error('首次修改前必须建立备份密码');
    error.code = 'BACKUP_PASSWORD_REQUIRED';
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    wx.showModal({
      title: '建立备份密码',
      content: `请设置用于加密备份的密码，${BACKUP_PASSWORD_RULE}。备份文件离开设备后，就只有这个密码在保护它，请设得长一些。如需空密码，请在设置页明确确认。`,
      editable: true,
      placeholderText: `输入 ${BACKUP_PASSWORD_RULE} 备份密码`,
      // confirmText / cancelText 最多 4 个字,超了 showModal 会直接 fail、弹不出来
      confirmText: '建立',
      cancelText: '取消',
      success: async (res) => {
        const password = String(res.content || '');
        if (!res.confirm) return reject(Object.assign(new Error('用户取消了数据变更'), { code: 'BACKUP_PASSWORD_REQUIRED' }));
        const verdict = checkBackupPasswordLength(password);
        if (!verdict.ok) {
          wx.showToast({ title: verdict.message, icon: 'none' });
          return reject(Object.assign(new Error(verdict.message), { code: 'BACKUP_PASSWORD_REQUIRED' }));
        }
        await updateBackupPassword(password);
        resolve(password);
      },
      // 没有 fail 回调的话,弹窗一旦失败这个 Promise 永远不落地,
      // 调用方就挂在那里,界面上看不出任何异常
      fail: (error) => reject(Object.assign(
        new Error('无法显示备份密码设置：' + ((error && error.errMsg) || '未知错误')),
        { code: 'BACKUP_PASSWORD_REQUIRED' })),
    });
  });
}

function promptBackupSetup() {
  if (typeof wx === 'undefined' || !wx.showModal) return;
  wx.showModal({
    title: '建议建立备份密码',
    content: '第一条数据已保存。设置备份密码后，换手机或清理微信数据时可以通过备份恢复；也可以稍后在设置中完成。',
    confirmText: '去设置',
    cancelText: '稍后',
    success: (result) => {
      if (!result.confirm || !wx.navigateTo) return;
      wx.navigateTo({ url: '/pages/settings/settings?mode=createBackupPassword' });
    },
  });
}

function generateBackupPassword(length = 16) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const size = Math.max(BACKUP_PASSWORD_MIN, Math.min(BACKUP_PASSWORD_MAX, Number(length) || 16));
  const random = require('./random.js');
  // 必须走拒绝采样,不能写 byte % chars.length ——
  // 字符集 65 个而 256 % 65 = 61,取模会让其中 61 个字符的概率高出 33%。
  // utils/generator.js 为此专门用了拒绝采样,这里曾经漏掉了。
  const out = [];
  for (let i = 0; i < size; i++) out.push(chars[random.intBelowSync(chars.length)]);
  return out.join('');
}

/** 生成 UUID v4。用 DRBG 而非 Math.random,避免 id 可预测。 */
function uuid() {
  const random = require('./random.js');
  let bytes;
  try {
    bytes = random.bytesSync(16);
  } catch (e) {
    // 随机数还没播种时的退路:时间戳 + 计数器。仅用于 id,不涉及密钥材料。
    bytes = new Uint8Array(16);
    const stamp = nowMs();
    for (let i = 0; i < 8; i++) bytes[i] = (stamp / Math.pow(256, i)) & 0xff;
    for (let i = 8; i < 16; i++) bytes[i] = (uuid._counter = (uuid._counter || 0) + 1) & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultGroup() {
  return {
    id: DEFAULT_GROUP_ID,
    name: '',
    sortOrder: 0,
    isDefault: true,
    createdAt: nowMs(),
    updatedAt: nowMs(),
  };
}

/** 保证默认分组存在,且所有密码的 group 指向真实存在的分组 */
function normalizeGroups() {
  if (!state.passwordGroups.some((g) => g.id === DEFAULT_GROUP_ID)) {
    state.passwordGroups.unshift(defaultGroup());
  }
  const valid = new Set(state.passwordGroups.map((g) => g.id));
  state.passwords.forEach((item) => {
    if (!item.group || !valid.has(item.group)) item.group = DEFAULT_GROUP_ID;
  });
}

/** 载入全部数据。重复调用共用同一个 Promise。 */
function ready() {
  if (loaded) return Promise.resolve(state);
  if (loading) return loading;

  loading = (async () => {
    const [passwords, groups, otpTokens, generations, trash, settings, webdav, qrHistory, backupSecret, backupConfigured] = await Promise.all([
      readKey(KEYS.passwords),
      readKey(KEYS.passwordGroups),
      readKey(KEYS.otpTokens),
      readKey(KEYS.generations),
      readKey(KEYS.trash),
      readKey(KEYS.settings),
      readKey(KEYS.webdav),
      readKey(KEYS.qrHistory),
      readKey(KEYS.backupSecret),
      readKey(KEYS.backupConfigured),
    ]);

    state.passwords = Array.isArray(passwords) ? passwords : [];
    state.passwordGroups = Array.isArray(groups) ? groups : [];
    state.otpTokens = Array.isArray(otpTokens) ? otpTokens : [];
    state.generations = Array.isArray(generations) ? generations : [];
    state.trash = Array.isArray(trash) ? trash : [];
    state.settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    state.webdav = Object.assign({}, DEFAULT_WEBDAV, normalizeWebdavConfig(webdav || {}));
    state.qrHistory = Array.isArray(qrHistory) ? qrHistory : [];
    state.backupSecret = typeof backupSecret === 'string' ? backupSecret : '';
    state.backupConfigured = backupConfigured === true || !!state.backupSecret;

    normalizeGroups();
    purgeExpiredTrash();
    applyGenerationRetention();

    loaded = true;
    loading = null;
    return state;
  })().catch((err) => {
    loading = null;
    loadError = err;
    throw err;
  });

  return loading;
}

/** 保存指定集合。只写被改动的键,减少写放大。 */
async function persist(...collections) {
  const targets = collections.length ? collections : Object.keys(KEYS);
  await Promise.all(targets.map((name) => writeKey(KEYS[name], state[name])));
  notify();
  const primaryDataCollections = new Set(['passwords', 'otpTokens']);
  const changedPrimaryData = targets.some((name) => primaryDataCollections.has(name));
  const hasPrimaryData = state.passwords.length || state.otpTokens.length;
  if (changedPrimaryData && hasPrimaryData && !state.backupConfigured && !backupPrompted && !state.settings.backupPromptSeen) {
    backupPrompted = true;
    state.settings.backupPromptSeen = true;
    // 提示只出现一次；保存失败不影响刚完成的数据写入。
    writeKey(KEYS.settings, state.settings).catch(() => {});
    // 先让调用方展示“已保存”，再进行非阻塞引导。
    setTimeout(promptBackupSetup, 450);
  }
}

// ---- 密码 ----

function listPasswords({ keyword = '', group = '', sort = 'time' } = {}) {
  const text = keyword.trim().toLowerCase();
  let result = state.passwords.filter((item) => {
    if (group && item.group !== group) return false;
    if (!text) return true;
    return [item.title, item.site, item.username, item.notes]
      .some((field) => (field || '').toLowerCase().indexOf(text) >= 0);
  });
  result = result.slice();
  if (sort === 'name') {
    result.sort((a, b) => compareTitle(a.title || '', b.title || ''));
  } else if (sort === 'manual') {
    // 手动排序:用户拖出来的顺序。没排过的(sortOrder 缺失)排在后面,
    // 组内再按更新时间,保证是全序 —— 否则两条都没 sortOrder 时顺序会飘。
    result.sort((a, b) => {
      const left = Number.isFinite(a.sortOrder) ? a.sortOrder : Infinity;
      const right = Number.isFinite(b.sortOrder) ? b.sortOrder : Infinity;
      if (left !== right) return left - right;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  } else {
    result.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return result;
}

/**
 * 按给定的 id 顺序重排。
 *
 * 只写 sortOrder,不动 updatedAt —— 拖一下顺序不该让这条记录"变新",
 * 否则按时间排序的视图会被搅乱,增量备份也会误以为内容改了。
 *
 * 传进来的 id 可能只是全部条目的一个子集(搜索/分组筛选后拖的),
 * 所以先按现有顺序取出这批条目,把新顺序填回它们**原本占据的那些位次**,
 * 没参与的条目位次不变。
 *
 * @param {'otpTokens'|'passwords'} collection
 * @param {string[]} orderedIds 拖动后的完整 id 顺序(可为子集)
 */
async function reorderByIds(collection, orderedIds) {
  const rows = state[collection];
  if (!Array.isArray(orderedIds) || !orderedIds.length) return;

  const byId = new Map(rows.map((row) => [row.id, row]));
  const moving = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  if (moving.length < 2) return;

  // 这批条目当前占据的位次(在全量数组里的下标),升序
  const slots = moving
    .map((row) => rows.indexOf(row))
    .sort((a, b) => a - b);

  const next = rows.slice();
  slots.forEach((slot, i) => { next[slot] = moving[i]; });
  state[collection] = next;

  // sortOrder 重新按数组下标编号,让它和数组顺序始终一致
  next.forEach((row, i) => { row.sortOrder = i; });
  await persist(collection);
}

const reorderOtpTokens = (orderedIds) => reorderByIds('otpTokens', orderedIds);
const reorderPasswords = (orderedIds) => reorderByIds('passwords', orderedIds);

/**
 * 按名称排序的比较函数。
 *
 * 不直接用 localeCompare('zh-Hans-CN'):微信 iOS 跑 JavaScriptCore、安卓跑 V8,
 * ICU 数据不一定齐,同一份数据两端可能排出不同顺序。
 *
 * 所以分两层:
 *   1. 分组用显式规则 —— 西文/数字开头在前,中文等在后。这一层跨端绝对一致。
 *   2. 组内再交给 localeCompare,引擎支持时得到拼音序,不支持时退化为码点序。
 *      中文组内的细微顺序可能有平台差异,但不会出现"整块中文跑到最前面"这种明显不一致。
 *
 * 真正的拼音排序需要带一张字表,对小程序包体不值得。
 */
function compareTitle(left, right) {
  const groupOf = (text) => (/^[\x20-\x7e]/.test(text) ? 0 : 1);
  const leftGroup = groupOf(left);
  const rightGroup = groupOf(right);
  if (leftGroup !== rightGroup) return leftGroup - rightGroup;
  const result = left.localeCompare(right, 'zh-Hans-CN');
  if (result !== 0) return result;
  // localeCompare 判等但字面不同时,兜一层码点序,保证排序是全序(稳定)
  return left < right ? -1 : left > right ? 1 : 0;
}

function getPassword(id) {
  return state.passwords.find((item) => item.id === id) || null;
}

async function savePassword(input) {

  const item = Object.assign({}, input);
  item.title = (item.title || '').trim();
  item.site = (item.site || '').trim();
  item.username = (item.username || '').trim();
  item.notes = item.notes || '';
  item.group = item.group || DEFAULT_GROUP_ID;
  item.updatedAt = nowMs();

  const index = item.id ? state.passwords.findIndex((row) => row.id === item.id) : -1;
  if (index >= 0) {
    item.createdAt = state.passwords[index].createdAt;
    state.passwords[index] = item;
  } else {
    item.id = item.id || uuid();
    item.createdAt = nowMs();
    state.passwords.unshift(item);
  }
  normalizeGroups();
  await persist('passwords', 'passwordGroups');
  return item;
}

async function deletePassword(id) {

  const index = state.passwords.findIndex((item) => item.id === id);
  if (index < 0) return false;
  const [removed] = state.passwords.splice(index, 1);
  state.trash.unshift({
    id: uuid(),
    kind: 'password',
    title: removed.title || removed.site || '未命名',
    deletedAt: nowMs(),
    payload: removed,
  });
  await persist('passwords', 'trash');
  return true;
}

// ---- 分组 ----

function listGroups() {
  return state.passwordGroups
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .map((group) => Object.assign({}, group, {
      count: state.passwords.filter((item) => item.group === group.id).length,
      displayName: group.id === DEFAULT_GROUP_ID ? '默认分组' : group.name,
    }));
}

async function createGroup(name) {

  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('分组名不能为空');
  if (state.passwordGroups.some((g) => g.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error('已有同名分组');
  }
  const group = {
    id: uuid(),
    name: trimmed,
    sortOrder: state.passwordGroups.length,
    isDefault: false,
    createdAt: nowMs(),
    updatedAt: nowMs(),
  };
  state.passwordGroups.push(group);
  await persist('passwordGroups');
  return group;
}

async function renameGroup(id, name) {

  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('分组名不能为空');
  if (id === DEFAULT_GROUP_ID) throw new Error('默认分组不能重命名');
  const group = state.passwordGroups.find((g) => g.id === id);
  if (!group) throw new Error('分组不存在');
  group.name = trimmed;
  group.updatedAt = nowMs();
  await persist('passwordGroups');
}

/** 删除分组。组内密码退回默认分组,不跟着删。 */
async function deleteGroup(id) {

  if (id === DEFAULT_GROUP_ID) throw new Error('默认分组不能删除');
  state.passwordGroups = state.passwordGroups.filter((g) => g.id !== id);
  state.passwords.forEach((item) => {
    if (item.group === id) item.group = DEFAULT_GROUP_ID;
  });
  await persist('passwordGroups', 'passwords');
}

// ---- TOTP ----

/**
 * @param {string} keyword 搜索词
 * @param {'default'|'manual'} sort
 *   default —— 置顶的排最前,再按 sortOrder;
 *   manual  —— 完全按用户拖出来的顺序,**不再把置顶项浮到最前**。
 *              手动排序就是用户明确指定的顺序,再让 pinned 插队会让
 *              "拖到哪就在哪"这件事失效;置顶标记本身仍然保留和显示。
 */
function listOtpTokens(keyword = '', sort = 'default') {
  const text = keyword.trim().toLowerCase();
  return state.otpTokens
    .filter((item) => {
      if (!text) return true;
      return [item.issuer, item.accountName].some((f) => (f || '').toLowerCase().indexOf(text) >= 0);
    })
    .slice()
    .sort((a, b) => {
      if (sort !== 'manual' && !!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if ((a.sortOrder || 0) !== (b.sortOrder || 0)) return (a.sortOrder || 0) - (b.sortOrder || 0);
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
}

function getOtpToken(id) {
  return state.otpTokens.find((item) => item.id === id) || null;
}

async function saveOtpToken(input) {

  const item = Object.assign({ digits: 6, period: 30, algorithm: 'SHA1', pinned: false }, input);
  item.issuer = (item.issuer || '').trim();
  item.accountName = (item.accountName || '').trim();
  item.updatedAt = nowMs();

  const index = item.id ? state.otpTokens.findIndex((row) => row.id === item.id) : -1;
  if (index >= 0) {
    item.createdAt = state.otpTokens[index].createdAt;
    item.sortOrder = state.otpTokens[index].sortOrder;
    state.otpTokens[index] = item;
  } else {
    // 同一密钥 + 同一发行商 + 同一账号视为重复,避免扫两次出两条
    const duplicate = state.otpTokens.find(
      (row) =>
        row.secret === item.secret &&
        (row.issuer || '').toLowerCase() === item.issuer.toLowerCase() &&
        (row.accountName || '').toLowerCase() === item.accountName.toLowerCase()
    );
    if (duplicate) {
      const error = new Error('这个验证码已经添加过了');
      error.code = 'DUPLICATE';
      error.existingId = duplicate.id;
      throw error;
    }
    item.id = item.id || uuid();
    item.createdAt = nowMs();
    item.sortOrder = state.otpTokens.reduce((max, row) => Math.max(max, row.sortOrder || 0), -1) + 1;
    state.otpTokens.push(item);
  }
  await persist('otpTokens');
  return item;
}

/**
 * 将已经过协议校验的多条 OTP 合并进当前设备。
 * 与逐条 saveOtpToken 相同地按“密钥 + 发行商 + 账号”去重，但只持久化一次，
 * 适合全量二维码迁移完成后的批量写入。
 */
async function importOtpTokens(inputs) {
  if (!Array.isArray(inputs)) throw new Error('验证码导入内容不正确');
  const counts = { added: 0, duplicate: 0 };
  let nextSortOrder = state.otpTokens.reduce((max, row) => Math.max(max, row.sortOrder || 0), -1) + 1;

  inputs.forEach((source) => {
    const item = Object.assign({ digits: 6, period: 30, algorithm: 'SHA1', pinned: false }, source || {});
    item.issuer = String(item.issuer || '').trim();
    item.accountName = String(item.accountName || '').trim();
    const duplicate = state.otpTokens.find(
      (row) =>
        row.secret === item.secret &&
        (row.issuer || '').toLowerCase() === item.issuer.toLowerCase() &&
        (row.accountName || '').toLowerCase() === item.accountName.toLowerCase()
    );
    if (duplicate) {
      counts.duplicate += 1;
      return;
    }
    item.id = uuid();
    item.createdAt = nowMs();
    item.updatedAt = nowMs();
    item.sortOrder = nextSortOrder;
    nextSortOrder += 1;
    state.otpTokens.push(item);
    counts.added += 1;
  });

  if (counts.added) await persist('otpTokens');
  return counts;
}

async function deleteOtpToken(id) {

  const index = state.otpTokens.findIndex((item) => item.id === id);
  if (index < 0) return false;
  const [removed] = state.otpTokens.splice(index, 1);
  state.trash.unshift({
    id: uuid(),
    kind: 'otp',
    title: removed.issuer || removed.accountName || '未命名',
    deletedAt: nowMs(),
    payload: removed,
  });
  await persist('otpTokens', 'trash');
  return true;
}

async function toggleOtpPinned(id) {

  const item = state.otpTokens.find((row) => row.id === id);
  if (!item) return;
  item.pinned = !item.pinned;
  item.updatedAt = nowMs();
  await persist('otpTokens');
}

// ---- 生成历史 ----

function listGenerations() {
  return state.generations.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function addGeneration(password, configSummary) {

  state.generations.unshift({
    id: uuid(),
    password,
    length: password.length,
    configSummary,
    createdAt: nowMs(),
  });
  applyGenerationRetention();
  await persist('generations');
}

async function deleteGenerations(ids) {

  const set = new Set(ids);
  state.generations = state.generations.filter((item) => !set.has(item.id));
  await persist('generations');
}

function applyGenerationRetention() {
  if (state.settings.generationRetention === 'month') {
    const cutoff = nowMs() - 30 * 86400000;
    state.generations = state.generations.filter((item) => (item.createdAt || 0) >= cutoff);
  } else if (state.generations.length > 500) {
    state.generations = state.generations.slice(0, 500);
  }
}

// ---- 回收站 ----

function listTrash() {
  return state.trash.slice().sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
}

function purgeExpiredTrash() {
  const days = state.settings.trashRetentionDays;
  if (!days) return; // 0 = 永久保留
  const cutoff = nowMs() - days * 86400000;
  state.trash = state.trash.filter((item) => (item.deletedAt || 0) >= cutoff);
}

async function restoreTrash(id) {
  const index = state.trash.findIndex((item) => item.id === id);
  if (index < 0) return false;
  const item = state.trash[index];
  if (item.kind === 'password') {
    if (!state.passwords.some((row) => row.id === item.payload.id)) state.passwords.unshift(item.payload);
  } else if (item.kind === 'otp') {
    if (!state.otpTokens.some((row) => row.id === item.payload.id)) state.otpTokens.push(item.payload);
  }
  state.trash.splice(index, 1);
  normalizeGroups();
  await persist('passwords', 'otpTokens', 'trash', 'passwordGroups');
  return true;
}

async function deleteTrashForever(ids) {
  const set = new Set(ids);
  state.trash = state.trash.filter((item) => !set.has(item.id));
  await persist('trash');
}

async function emptyTrash() {
  state.trash = [];
  await persist('trash');
}

// ---- 二维码历史 ----

function listQrHistory() {
  return state.qrHistory.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function addQrHistory(content, source = 'generated') {

  const text = String(content || '').trim();
  if (!text) throw new Error('二维码内容不能为空');
  state.qrHistory.unshift({ id: uuid(), content: text, source, createdAt: nowMs() });
  if (state.qrHistory.length > 100) state.qrHistory = state.qrHistory.slice(0, 100);
  await persist('qrHistory');
  return state.qrHistory[0];
}

async function deleteQrHistory(id) {

  state.qrHistory = state.qrHistory.filter((item) => item.id !== id);
  await persist('qrHistory');
}

async function clearQrHistory() {
  state.qrHistory = [];
  await persist('qrHistory');
}

// ---- 设置 / WebDAV ----

function getSettings() {
  return Object.assign({}, state.settings);
}

async function updateSettings(patch) {
  Object.assign(state.settings, patch);
  if (patch.trashRetentionDays !== undefined) purgeExpiredTrash();
  if (patch.generationRetention !== undefined) applyGenerationRetention();
  await persist('settings', 'trash', 'generations');
}

function normalizeWebdavConfig(input) {
  const source = Object.assign({}, input || {});
  // 兼容旧版本可能使用的字段名，统一为当前页面和客户端使用的 appPassword。
  if (!source.account) source.account = source.username || source.user || source.email || '';
  if (!source.appPassword) source.appPassword = source.password || source.webdavPassword || source.davPassword || '';
  if (!source.url) source.url = DEFAULT_WEBDAV.url;
  if (!source.provider) source.provider = DEFAULT_WEBDAV.provider;
  return source;
}

function getWebdav() {
  return normalizeWebdavConfig(state.webdav);
}

async function updateWebdav(patch) {
  const normalized = normalizeWebdavConfig(Object.assign({}, state.webdav, patch || {}));
  state.webdav = Object.assign({}, state.webdav, normalized);
  await persist('webdav');
}

function getBackupPassword() { return state.backupSecret; }
function isBackupPasswordConfigured() { return !!state.backupConfigured; }
function verifyBackupPassword(password) {
  return state.backupConfigured && String(password == null ? '' : password) === state.backupSecret;
}
async function updateBackupPassword(password) {
  const value = String(password == null ? '' : password);
  // 只在**设置新密码**时校验长度。verifyBackupPassword 不校验 ——
  // 老用户可能存着旧规则下的短密码,不能因为改了策略就让他打不开自己的备份。
  const verdict = checkBackupPasswordLength(value);
  if (!verdict.ok) {
    const error = new Error(verdict.message);
    error.code = 'INVALID_BACKUP_PASSWORD_LENGTH';
    throw error;
  }
  state.backupSecret = value;
  state.backupConfigured = true;
  await Promise.all([
    writeKey(KEYS.backupSecret, value),
    writeKey(KEYS.backupConfigured, true),
  ]);
}

async function confirmEmptyBackupPassword() {
  state.backupSecret = '';
  state.backupConfigured = true;
  await Promise.all([
    writeKey(KEYS.backupSecret, ''),
    writeKey(KEYS.backupConfigured, true),
  ]);
}

// ---- 备份快照 ----

/** 导出用的快照。回收站不进备份 —— 恢复一份备份不该把别处删掉的东西带回来。 */
function snapshot() {
  return {
    format: 'otplab-miniprogram',
    version: 1,
    exportedAt: nowMs(),
    passwords: state.passwords,
    passwordGroups: state.passwordGroups,
    otpTokens: state.otpTokens,
    generations: state.generations,
    settings: state.settings,
    qrHistory: state.qrHistory,
  };
}

/**
 * 从快照恢复。**合并**而非覆盖:同 id 取较新者,不同 id 直接加入。
 * 这样在两台设备之间来回恢复不会丢东西。
 * @returns {{passwords: number, otpTokens: number, groups: number}} 新增/更新的条数
 */
/**
 * 从备份快照恢复数据。有意不恢复 settings/trash:
 * - settings 含主题、锁定等设备相关配置,
 *   用旧设备的配置覆盖新设备会造成体验和安全设置混乱;
 * - trash 是本机删除记录,不属于「数据迁移」范畴。
 * 备份恢复的是数据,不是本机配置 —— 改这个行为前先想清楚。
 */
async function restoreSnapshot(data) {
  if (!data || typeof data !== 'object') throw new Error('备份内容为空');
  const counts = { passwords: 0, otpTokens: 0, groups: 0 };

  // 注:备份快照里的 settings 字段(自动锁定时长 / 主题 / 自动备份开关等)有意不恢复。
  // 这是产品决策而非疏漏 —— 换设备 / 换新机恢复时,应保留新设备上现有的本地配置,
  // 避免旧设备的设置(尤其自动锁定时长这类安全项)静默覆盖新设备的配置。
  // 若未来要支持配置迁移,可在此处显式合并 settings,但需先与自动备份 / 本地锁定流程对齐。

  (data.passwordGroups || []).forEach((group) => {
    if (!group || !group.id) return;
    const existing = state.passwordGroups.find((g) => g.id === group.id);
    if (!existing) {
      state.passwordGroups.push(group);
      counts.groups++;
    } else if ((group.updatedAt || 0) > (existing.updatedAt || 0)) {
      Object.assign(existing, group);
      counts.groups++;
    }
  });

  (data.passwords || []).forEach((item) => {
    if (!item || !item.id) return;
    const index = state.passwords.findIndex((row) => row.id === item.id);
    if (index < 0) {
      state.passwords.push(item);
      counts.passwords++;
    } else if ((item.updatedAt || 0) > (state.passwords[index].updatedAt || 0)) {
      state.passwords[index] = item;
      counts.passwords++;
    }
  });

  (data.otpTokens || []).forEach((item) => {
    if (!item || !item.id) return;
    const index = state.otpTokens.findIndex((row) => row.id === item.id);
    if (index < 0) {
      state.otpTokens.push(item);
      counts.otpTokens++;
    } else if ((item.updatedAt || 0) > (state.otpTokens[index].updatedAt || 0)) {
      state.otpTokens[index] = item;
      counts.otpTokens++;
    }
  });

  (data.generations || []).forEach((item) => {
    if (item && item.id && !state.generations.some((row) => row.id === item.id)) {
      state.generations.push(item);
    }
  });

  (data.qrHistory || []).forEach((item) => {
    if (item && item.id && !state.qrHistory.some((row) => row.id === item.id)) {
      state.qrHistory.push(item);
    }
  });
  if (state.qrHistory.length > 100) state.qrHistory = state.qrHistory.slice(0, 100);

  normalizeGroups();
  applyGenerationRetention();
  await persist('passwords', 'passwordGroups', 'otpTokens', 'generations', 'qrHistory');
  return counts;
}

/** 首页统计 */
function stats() {
  return {
    passwordCount: state.passwords.length,
    otpCount: state.otpTokens.length,
    trashCount: state.trash.length,
    weakCount: state.passwords.filter((item) => {
      const { strengthScore } = require('./generator.js');
      return item.password && strengthScore(item.password) < 45;
    }).length,
    duplicateCount: (() => {
      const seen = new Map();
      let duplicates = 0;
      state.passwords.forEach((item) => {
        if (!item.password) return;
        const count = (seen.get(item.password) || 0) + 1;
        seen.set(item.password, count);
        if (count === 2) duplicates += 2;
        else if (count > 2) duplicates += 1;
      });
      return duplicates;
    })(),
    webdavConfigured: !!(state.webdav.account && state.webdav.appPassword),
    lastSyncAt: state.webdav.lastSyncAt,
  };
}

/** 仅测试用:重置内存与内存版存储 */
function _reset() {
  state.passwords = [];
  state.passwordGroups = [];
  state.otpTokens = [];
  state.generations = [];
  state.trash = [];
  state.settings = Object.assign({}, DEFAULT_SETTINGS);
  state.webdav = Object.assign({}, DEFAULT_WEBDAV);
  state.qrHistory = [];
  state.backupSecret = '';
  state.backupConfigured = false;
  backupPrompted = false;
  memoryFallback.clear();
  loaded = false;
  loading = null;
}

module.exports = {
  ready,
  subscribe,
  state,
  uuid,
  generateBackupPassword,
  ensureBackupPassword,
  DEFAULT_GROUP_ID,
  DEFAULT_SETTINGS,
  listPasswords, getPassword, savePassword, deletePassword,
  listGroups, createGroup, renameGroup, deleteGroup,
  compareTitle,
  listOtpTokens, getOtpToken, saveOtpToken, importOtpTokens, deleteOtpToken, toggleOtpPinned,
  reorderOtpTokens, reorderPasswords,
  listGenerations, addGeneration, deleteGenerations,
  listTrash, restoreTrash, deleteTrashForever, emptyTrash,
  getSettings, updateSettings,
  getWebdav, updateWebdav, normalizeWebdavConfig, getBackupPassword, isBackupPasswordConfigured, verifyBackupPassword, updateBackupPassword, confirmEmptyBackupPassword,
  BACKUP_PASSWORD_MIN, BACKUP_PASSWORD_MAX, BACKUP_PASSWORD_RULE, checkBackupPasswordLength,
  promptBackupSetup,
  listQrHistory, addQrHistory, deleteQrHistory, clearQrHistory,
  snapshot, restoreSnapshot, stats,
  get loadError() { return loadError; },
  _reset,
};
