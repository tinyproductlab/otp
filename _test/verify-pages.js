/*
 * 页面逻辑层冒烟测试。运行: node _test/verify-pages.js
 *
 * 用 wx / Page / getApp 的桩件真实加载每个页面,调用 onLoad 和各事件处理器。
 * 这测不了渲染(WXML/WXSS 只能在真机或开发者工具里验),但能抓出
 * setData 路径写错、引用未定义、data-* 取不到值这类逻辑 bug。
 */

const path = require('path');
const store = require('../utils/store.js');
const random = require('../utils/random.js');
const otpTransfer = require('../utils/otp-transfer.js');
const otpBundleTransfer = require('../utils/otp-bundle-transfer.js');

let pass = 0;
let fail = 0;
const problems = [];

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    problems.push(name + (detail ? ' — ' + detail : ''));
    console.log(`  ✗ ${name}${detail ? '\n      ' + detail : ''}`);
  }
}

// ---------- 桩件 ----------

const wxCalls = [];

global.wx = {
  // 记录调用,便于断言"点了按钮之后确实弹了框"
  showToast: (o) => wxCalls.push(['showToast', o]),
  showModal: (o) => { wxCalls.push(['showModal', o]); },
  showLoading: (o) => wxCalls.push(['showLoading', o]),
  hideLoading: () => wxCalls.push(['hideLoading']),
  showActionSheet: (o) => wxCalls.push(['showActionSheet', o]),
  setClipboardData: (o) => { wxCalls.push(['setClipboardData', o]); if (o.success) o.success(); },
  navigateTo: (o) => wxCalls.push(['navigateTo', o]),
  navigateBack: () => wxCalls.push(['navigateBack']),
  reLaunch: (o) => wxCalls.push(['reLaunch', o]),
  setNavigationBarTitle: (o) => wxCalls.push(['setNavigationBarTitle', o]),
  scanCode: (o) => wxCalls.push(['scanCode', o]),
  getStorageInfo: (o) => { if (o.success) o.success({ currentSize: 12, limitSize: 10240 }); },
  clearStorageSync: () => {},
  getFileSystemManager: () => ({ writeFileSync: () => {} }),
  shareFileMessage: (o) => wxCalls.push(['shareFileMessage', o]),
  chooseMessageFile: (o) => wxCalls.push(['chooseMessageFile', o]),
  createCanvasContext: () => ({ setFillStyle: () => {}, fillRect: () => {}, draw: () => {} }),
  nextTick: (fn) => fn(),
  env: { USER_DATA_PATH: '/tmp' },
  // 存储走 store.js 的内存后端,这里不实现
};

let currentPage = null;
let themeApplyCount = 0;

global.Page = function (config) {
  currentPage = config;
};

global.getApp = () => ({
  globalData: { ready: true, readyError: null },
  ready: () => Promise.resolve(),
  applyTheme: () => { themeApplyCount += 1; },
});
global.getCurrentPages = () => [{}, {}];

/** 载入一个页面模块,返回可操作的实例 */
function loadPage(name) {
  currentPage = null;
  const modulePath = path.join(__dirname, '..', 'pages', name, name + '.js');
  delete require.cache[require.resolve(modulePath)];
  require(modulePath);
  if (!currentPage) throw new Error('页面没有调用 Page()');

  const instance = Object.assign({}, currentPage);
  instance.data = JSON.parse(JSON.stringify(currentPage.data || {}));
  instance.setData = function (patch, callback) {
    Object.keys(patch).forEach((key) => {
      if (key.indexOf('.') < 0) {
        this.data[key] = patch[key];
        return;
      }
      // 支持 'form.title' 这种路径,和小程序行为一致
      const parts = key.split('.');
      let target = this.data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (target[parts[i]] === undefined) {
          throw new Error(`setData 路径不存在: ${key}(${parts[i]} 是 undefined)`);
        }
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = patch[key];
    });
    if (callback) callback();
  };
  return instance;
}

const tap = (dataset) => ({ currentTarget: { dataset: dataset || {} } });
const input = (value, dataset) => ({ detail: { value }, currentTarget: { dataset: dataset || {} } });

// ---------- 测试 ----------

(async () => {
  await random.prefetch();

  // 准备一些数据,让列表页有东西可渲染
  store._reset();
  await store.ready();
  const pw = await store.savePassword({ title: 'GitHub', site: 'github.com', username: 'dev@example.com', password: 'Gh!tHub#2024' });
  await store.savePassword({ title: '支付宝', site: 'alipay.com', username: '13800138000', password: 'weak' });
  const token = await store.saveOtpToken({ issuer: 'Google', accountName: 'user@gmail.com', secret: 'JBSWY3DPEHPK3PXP' });
  await store.addGeneration('Abc123!@#xyz', '12 位');
  const removed = await store.savePassword({ title: '待删', password: 'x' });
  await store.deletePassword(removed.id);

  console.log('\n首页 index');
  {
    let page;
    try {
      page = loadPage('index');
      await page.onLoad.call(page);
      await new Promise((r) => setTimeout(r, 10));
      check('onLoad 不抛错', true);
      check('统计已填充', page.data.stats.passwordCount === 2, `实际 ${page.data.stats.passwordCount}`);
      check('TOTP 计数正确', page.data.stats.otpCount === 1, `实际 ${page.data.stats.otpCount}`);
      check('安全状态三行都有文案',
        !!(page.data.security.storage.text && page.data.security.backup.text && page.data.security.strength.text));
      check('未备份时提示为 bad', page.data.security.backup.level === 'bad', page.data.security.backup.level);
      check('弱密码被识别', /弱密码/.test(page.data.security.strength.text), page.data.security.strength.text);
      check('默认停在首页(current=1)', page.data.current === 1, String(page.data.current));
      page.onTab.call(page, tap({ index: '2' }));
      check('切页生效', page.data.current === 2, String(page.data.current));
      page.onPageChange.call(page, { detail: { current: 0 } });
      check('滑动同步 current', page.data.current === 0);
      ['onOpenOtp', 'onOpenSecurityPlan', 'onOpenPassword', 'onGenerator', 'onBackup', 'onTrash', 'onSettings', 'onExport'].forEach((fn) => {
        page[fn].call(page);
      });
      check('8 个导航入口都能调用', true);
      page.onScan.call(page);
      const scanCall = wxCalls.find((c) => c[0] === 'scanCode');
      check('扫码入口调用 wx.scanCode', !!scanCall);
      page.onTokenLongPress.call(page, tap({ id: token.id }));
      const longPress = wxCalls.filter((c) => c[0] === 'showActionSheet').pop();
      check('长按菜单提供迁移二维码', longPress && longPress[1].itemList.indexOf('生成迁移二维码') >= 0);
      if (longPress && longPress[1].success) longPress[1].success({ tapIndex: 2 });
      check('迁移二维码从长按菜单进入内部页面', wxCalls.some((c) => c[0] === 'navigateTo' && /otp-transfer.*id=/.test(c[1].url)));
      const transferPayload = (await otpTransfer.encrypt({ issuer: '迁移测试', accountName: 'scan@example.com', secret: 'JBSWY3DPEHPK3PXP' }, 'transfer-123', { expiryMinutes: 15, iterations: 1000 })).payload;
      if (scanCall && scanCall[1].success) await scanCall[1].success({ result: transferPayload });
      check('扫码添加会分流加密迁移二维码', wxCalls.some((c) => c[0] === 'navigateTo' && /otp-transfer.*mode=import/.test(c[1].url)));
      const bundlePayload = (await otpBundleTransfer.encrypt([{ issuer: '批量扫码', accountName: 'bundle-scan@example.com', secret: 'JBSWY3DPEHPK3PXP' }], '123456', { expiryMinutes: 15, iterations: 1000 })).payloads[0];
      if (scanCall && scanCall[1].success) await scanCall[1].success({ result: bundlePayload });
      check('扫码添加会分流全部 OTP 迁移二维码', wxCalls.some((c) => c[0] === 'navigateTo' && /otp-bundle-transfer.*mode=import/.test(c[1].url)));
      if (page.onUnload) page.onUnload.call(page);
    } catch (error) {
      check('首页加载', false, error.message);
    }
  }

  console.log('\nOTP 迁移二维码 otp-transfer');
  {
    try {
      wxCalls.length = 0;
      let page = loadPage('otp-transfer');
      await page.onLoad.call(page, { id: token.id });
      await new Promise((r) => setTimeout(r, 10));
      check('迁移导出页加载现有 OTP', page.data.mode === 'create' && page.data.token && page.data.token.id === token.id);
      page.onInput.call(page, input('123456', { key: 'transferPassword' }));
      page.onSelectExpiry.call(page, tap({ value: '5' }));
      check('迁移有效期选择生效', page.data.expiryMinutes === 5);
      await page.onGenerate.call(page);
      check('迁移导出生成二维码状态', page.data.stage === 'qr' && /^OTPT1\./.test(page.data.qrPayload));
      if (page.onUnload) page.onUnload.call(page);

      const transferPayload = (await otpTransfer.encrypt({ issuer: '迁移导入', accountName: 'import@example.com', secret: 'JBSWY3DPEHPK3PXP' }, '123456', { expiryMinutes: 15, iterations: 1000 })).payload;
      page = loadPage('otp-transfer');
      await page.onLoad.call(page, { mode: 'import', payload: encodeURIComponent(transferPayload) });
      await new Promise((r) => setTimeout(r, 10));
      check('迁移导入页识别加密二维码', page.data.mode === 'import' && page.data.stage === 'import');
      page.onInput.call(page, input('123456', { key: 'importPassword' }));
      await page.onDecryptImport.call(page);
      check('迁移导入后显示成功状态', page.data.stage === 'success');
      if (page.onUnload) page.onUnload.call(page);
    } catch (error) {
      check('OTP 迁移二维码页面', false, error.message);
    }
  }

  console.log('\n全量 OTP 迁移二维码 otp-bundle-transfer');
  {
    try {
      wxCalls.length = 0;
      let page = loadPage('otp-bundle-transfer');
      await page.onLoad.call(page, {});
      await new Promise((r) => setTimeout(r, 10));
      check('全量迁移导出页加载 OTP 数量', page.data.mode === 'create' && page.data.tokenCount >= 2, String(page.data.tokenCount));
      page.onInput.call(page, input('123456', { key: 'transferPassword' }));
      page.onSelectExpiry.call(page, tap({ value: '5' }));
      await page.onGenerate.call(page);
      check('全量迁移自动生成分片二维码', page.data.stage === 'qr' && page.data.qrTotal >= 1 && page.data.qrGrid.length > 0, String(page.data.qrTotal));
      if (page.onUnload) page.onUnload.call(page);

      const bundleTokens = Array.from({ length: 8 }, (_, index) => ({
        issuer: `全量导入 ${index + 1}`,
        accountName: `all-${index + 1}@example.com`,
        secret: 'JBSWY3DPEHPK3PXP',
      }));
      const bundle = await otpBundleTransfer.encrypt(bundleTokens, '123456', { expiryMinutes: 15, iterations: 1000 });
      page = loadPage('otp-bundle-transfer');
      await page.onLoad.call(page, { mode: 'import', payload: encodeURIComponent(bundle.payloads[0]) });
      await new Promise((r) => setTimeout(r, 10));
      check('全量迁移导入页开始收集分片', page.data.mode === 'import' && page.data.stage === 'collect' && page.data.collectedCount === 1);
      bundle.payloads.slice(1).reverse().forEach((payload) => page.collectPayload.call(page, payload, false));
      check('收齐分片后进入解密页', page.data.stage === 'import' && page.data.collectedCount === bundle.total);
      page.onInput.call(page, input('123456', { key: 'importPassword' }));
      await page.onDecryptImport.call(page);
      check('全量迁移导入后显示成功状态', page.data.stage === 'success' && /已添加/.test(page.data.successText));
      if (page.onUnload) page.onUnload.call(page);
    } catch (error) {
      check('全量 OTP 迁移二维码页面', false, error.message);
    }
  }

  console.log('\n安全共生计划 security-plan');
  {
    try {
      wxCalls.length = 0;
      const page = loadPage('security-plan');
      await page.onLoad.call(page);
      await new Promise((r) => setTimeout(r, 10));
      check('onLoad 不抛错', true);
      check('默认建议来自本地', page.data.plan.source === 'local', page.data.plan.source);
      check('未备份时备份任务优先', page.data.plan.tasks[0].id === 'backup-first', page.data.plan.tasks[0].id);
      page.onTaskTap.call(page, tap({ action: 'backup-local' }));
      const nav = wxCalls.find((c) => c[0] === 'navigateTo');
      check('备份任务跳转微信导入导出', nav && /mode=wechat/.test(nav[1].url), nav ? nav[1].url : '未跳转');
      if (page.onUnload) page.onUnload.call(page);
    } catch (error) {
      check('安全共生计划加载', false, error.message);
    }
  }

  console.log('\nTOTP 列表 otp');
  {
    let page;
    try {
      page = loadPage('otp');
      await page.onLoad.call(page);
      await new Promise((r) => setTimeout(r, 10));
      check('onLoad 不抛错', true);
      const expectedOtpCount = store.listOtpTokens().length;
      check('列出迁移后的全部 OTP', page.data.tokens.length === expectedOtpCount, `实际 ${page.data.tokens.length}`);
      const row = page.data.tokens[0];
      check('验证码是 6 位带空格格式', /^\d{3} \d{3}$/.test(row.display), row.display);
      check('倒计时在 1..30', row.remaining >= 1 && row.remaining <= 30, String(row.remaining));
      check('进度百分比在 0..100', row.percent >= 0 && row.percent <= 100, String(row.percent));
      check('首字母兜底正确', row.initial === 'G', row.initial);
      page.onSearch.call(page, input('google'));
      check('搜索命中', page.data.tokens.length === 1);
      page.onSearch.call(page, input('zzz'));
      check('搜索无结果', page.data.tokens.length === 0);
      page.onClearSearch.call(page);
      check('清空搜索恢复', page.data.tokens.length === expectedOtpCount);
      wxCalls.length = 0;
      page.onCopy.call(page, tap({ id: token.id }));
      const clip = wxCalls.find((c) => c[0] === 'setClipboardData');
      check('复制的是纯数字(去掉了空格)', clip && /^\d{6}$/.test(clip[1].data), clip ? clip[1].data : '没调用');
      page.onLongPress.call(page, tap({ id: token.id }));
      check('长按弹出操作表', wxCalls.some((c) => c[0] === 'showActionSheet'));
      if (page.onHide) page.onHide.call(page);
      if (page.onUnload) page.onUnload.call(page);
    } catch (error) {
      check('TOTP 列表加载', false, error.message);
    }
  }

  console.log('\nTOTP 编辑 otp-edit');
  {
    try {
      // 新建模式
      let page = loadPage('otp-edit');
      await page.onLoad.call(page, {});
      await new Promise((r) => setTimeout(r, 10));
      check('新建模式 onLoad 不抛错', true);
      check('初始不可保存', page.data.canSave === false);
      page.onInput.call(page, input('GitHub', { key: 'issuer' }));
      check('填 issuer 后仍不可保存(缺密钥)', page.data.canSave === false);
      page.onSecretInput.call(page, input('JBSWY3DPEHPK3PXP'));
      check('填合法密钥后可保存', page.data.canSave === true);
      check('预览算出验证码', /^\d{3} \d{3}$/.test(page.data.previewCode), page.data.previewCode);
      check('预览标记为有效', page.data.previewOk === true);
      page.onSecretInput.call(page, input('!!!非法!!!'));
      check('非法密钥预览报错', page.data.previewCode === '密钥无效', page.data.previewCode);
      check('非法密钥不可保存', page.data.canSave === false);
      page.onSecretInput.call(page, input('JBSWY3DPEHPK3PXP'));
      page.onDigits.call(page, tap({ value: '8' }));
      check('切 8 位生效', page.data.form.digits === 8);
      check('预览变 8 位格式', /^\d{4} \d{4}$/.test(page.data.previewCode), page.data.previewCode);
      page.onPeriod.call(page, tap({ value: '60' }));
      check('切周期生效', page.data.form.period === 60);
      page.onAlgorithm.call(page, tap({ value: 'SHA256' }));
      check('切算法生效', page.data.form.algorithm === 'SHA256');
      check('SHA256 也能算出预览', page.data.previewOk === true);
      if (page.onHide) page.onHide.call(page);

      // 编辑模式
      page = loadPage('otp-edit');
      await page.onLoad.call(page, { id: token.id });
      await new Promise((r) => setTimeout(r, 10));
      check('编辑模式载入已有数据', page.data.form.issuer === 'Google', page.data.form.issuer);
      check('编辑模式 isEdit=true', page.data.isEdit === true);
      check('编辑模式可保存', page.data.canSave === true);
      if (page.onHide) page.onHide.call(page);
    } catch (error) {
      check('TOTP 编辑', false, error.message);
    }
  }

  console.log('\n密码列表 password');
  {
    try {
      const page = loadPage('password');
      await page.onLoad.call(page);
      await new Promise((r) => setTimeout(r, 10));
      check('onLoad 不抛错', true);
      check('列出 2 条', page.data.items.length === 2, `实际 ${page.data.items.length}`);
      check('total 正确', page.data.total === 2);
      check('每条有头像色', page.data.items.every((i) => /^#[0-9A-F]{6}$/i.test(i.avatarColor)));
      check('每条有首字母', page.data.items.every((i) => !!i.initial));
      const weak = page.data.items.find((i) => i.title === '支付宝');
      check('弱密码被标 risk=weak', weak && weak.risk === 'weak', weak ? weak.risk : '找不到');
      page.onSort.call(page);
      check('切换排序为 name', page.data.sort === 'name');
      page.onSearch.call(page, input('github'));
      check('搜索命中 1 条', page.data.items.length === 1);
      page.onClearSearch.call(page);
      check('清空搜索恢复 2 条', page.data.items.length === 2);
      wxCalls.length = 0;
      page.onCopyPassword.call(page, tap({ id: pw.id }));
      const clip = wxCalls.find((c) => c[0] === 'setClipboardData');
      check('点击密码条目复制正确', clip && clip[1].data === 'Gh!tHub#2024', clip ? clip[1].data : '没调用');
      check('点击复制显示行内反馈', page.data.copiedId === pw.id, page.data.copiedId);
      page.onLongPress.call(page, tap({ id: pw.id }));
      check('长按弹操作表', wxCalls.some((c) => c[0] === 'showActionSheet'));
      page.onGroup.call(page, tap({ id: '' }));
      check('分组筛选可调用', true);
      const filteredPage = loadPage('password');
      await filteredPage.onLoad.call(filteredPage, { risk: 'weak' });
      await new Promise((r) => setTimeout(r, 10));
      check('弱密码深链筛选生效', filteredPage.data.items.length === 1 && filteredPage.data.items[0].title === '支付宝');
      filteredPage.onClearRiskFilter.call(filteredPage);
      check('清除风险筛选恢复列表', filteredPage.data.items.length === 2);
      if (filteredPage.onUnload) filteredPage.onUnload.call(filteredPage);
      if (page.onUnload) page.onUnload.call(page);
    } catch (error) {
      check('密码列表', false, error.message);
    }
  }

  console.log('\n密码编辑 password-edit');
  {
    try {
      let page = loadPage('password-edit');
      await page.onLoad.call(page, {});
      await new Promise((r) => setTimeout(r, 10));
      check('新建模式 onLoad 不抛错', true);
      check('分组下拉有值', page.data.groupNames.length >= 1, JSON.stringify(page.data.groupNames));
      check('初始不可保存', page.data.canSave === false);
      page.onInput.call(page, input('新站点', { key: 'title' }));
      check('填标题后可保存', page.data.canSave === true);
      page.onPasswordInput.call(page, input('Abcdefghijk1!'));
      check('强度计算为 strong', page.data.strength.level === 'strong', page.data.strength.level);
      page.onToggleReveal.call(page);
      check('切换显示密码', page.data.revealed === true);
      check('编辑页不保留就地随机生成', typeof page.onGenerate === 'undefined');
      wxCalls.length = 0;
      page.onOpenGenerator.call(page);
      check('编辑页可进入独立密码生成器', wxCalls.some((c) => c[0] === 'navigateTo' && /pages\/generator\/generator\?pick=1/.test(c[1].url)));
      page.onGroupChange.call(page, { detail: { value: 0 } });
      check('切分组生效', page.data.form.group === page.data.groups[0].id);

      page = loadPage('password-edit');
      await page.onLoad.call(page, { id: pw.id });
      await new Promise((r) => setTimeout(r, 10));
      check('编辑模式载入数据', page.data.form.title === 'GitHub', page.data.form.title);
      check('编辑模式有创建时间文案', /^\d{4}-\d{2}-\d{2}/.test(page.data.createdAtText), page.data.createdAtText);
    } catch (error) {
      check('密码编辑', false, error.message);
    }
  }

  console.log('\n生成器 generator');
  {
    try {
      const page = loadPage('generator');
      await page.onLoad.call(page, {});
      await new Promise((r) => setTimeout(r, 30));
      check('onLoad 不抛错', true);
      check('进页面就有密码', page.data.password.length === 16, `实际 "${page.data.password}"`);
      check('历史已载入', page.data.history.length >= 1, `实际 ${page.data.history.length}`);
      check('历史有时间文案', !!page.data.history[0].timeText);
      check('默认加载日常策略', page.data.activeStrategy === 'daily' && page.data.strategy.options.length === 16);
      page.onSelectStrategy.call(page, tap({ id: 'important' }));
      await new Promise((r) => setTimeout(r, 10));
      check('重要账号策略设为 20 位', page.data.activeStrategy === 'important' && page.data.options.length === 20, String(page.data.options.length));
      page.onSelectStrategy.call(page, tap({ id: 'manual' }));
      await new Promise((r) => setTimeout(r, 10));
      check('手抄策略排除形近字符', page.data.options.excludeZeroO && page.data.options.excludeOneI && page.data.options.excludeLowerL);
      const before = page.data.password;
      await page.onRegenerate.call(page);
      await new Promise((r) => setTimeout(r, 10));
      check('换一个真的换了', page.data.password !== before);
      page.onLength.call(page, { type: 'changing', detail: { value: 32 } });
      check('拖动长度更新显示', page.data.password.length === 32, `实际 ${page.data.password.length}`);
      page.onToggle.call(page, { detail: { value: false }, currentTarget: { dataset: { key: 'includeSymbols' } } });
      await new Promise((r) => setTimeout(r, 10));
      check('关掉符号后不含符号', !/[!@#$%^&*]/.test(page.data.password), page.data.password);
      page.onToggleBoth.call(page, { detail: { value: true } });
      await new Promise((r) => setTimeout(r, 10));
      check('一个开关管两项', page.data.options.excludeLowerL === true && page.data.options.excludeLowerO === true);
      wxCalls.length = 0;
      page.onCopy.call(page);
      check('复制调用剪贴板', wxCalls.some((c) => c[0] === 'setClipboardData'));
    } catch (error) {
      check('生成器', false, error.message);
    }
  }

  console.log('\n回收站 trash');
  {
    try {
      const page = loadPage('trash');
      await page.onLoad.call(page);
      await new Promise((r) => setTimeout(r, 10));
      check('onLoad 不抛错', true);
      check('列出 1 条', page.data.items.length === 1, `实际 ${page.data.items.length}`);
      const row = page.data.items[0];
      check('类型标签正确', row.kindLabel === '密码', row.kindLabel);
      check('有到期文案', /天后清除|即将清除|永久保留/.test(row.expiryText), row.expiryText);
      check('保留期标签', page.data.retentionLabel === '30 天', page.data.retentionLabel);
      page.onToggle.call(page, tap({ id: row.id }));
      check('选中生效', page.data.selectedCount === 1, String(page.data.selectedCount));
      check('全选状态正确', page.data.allSelected === true);
      page.onToggleAll.call(page);
      check('取消全选', page.data.selectedCount === 0);
      page.onToggleAll.call(page);
      check('再次全选', page.data.selectedCount === 1);
      await page.onRestoreSelected.call(page);
      await new Promise((r) => setTimeout(r, 10));
      check('恢复所选后回收站空', page.data.items.length === 0, `实际 ${page.data.items.length}`);
      check('密码回到列表(共 3 条)', store.listPasswords().length === 3, `实际 ${store.listPasswords().length}`);
    } catch (error) {
      check('回收站', false, error.message);
    }
  }

  console.log('\n设置 settings');
  {
    try {
      const page = loadPage('settings');
      await page.onLoad.call(page, { mode: 'createBackupPassword' });
      await new Promise((r) => setTimeout(r, 10));
      check('onLoad 不抛错', true);
      check('设置已载入', page.data.settings.theme === 'system', page.data.settings.theme);
      check('保留期下标正确', page.data.retentionIndex === 1, String(page.data.retentionIndex));
      check('统计已填充', page.data.stats.passwordCount === 3, String(page.data.stats.passwordCount));
      check('存储占用有文案', /KB/.test(page.data.storageText), page.data.storageText);
      check('未设置备份密码时进入创建状态', page.data.backupPasswordConfigured === false, String(page.data.backupPasswordConfigured));
      check('首次引导直达创建画面', page.data.directBackupPasswordCreate === true, String(page.data.directBackupPasswordCreate));
      page.onToggleBackupPasswordVisibility.call(page);
      check('创建页密码可显示', page.data.backupPasswordVisible === true, String(page.data.backupPasswordVisible));
      page.onToggleBackupPasswordVisibility.call(page);
      check('创建页密码可重新隐藏', page.data.backupPasswordVisible === false, String(page.data.backupPasswordVisible));
      page.onNewBackupPassword.call(page, input('x'.repeat(80)));
      check('创建密码最长截断为 64 位', page.data.newBackupPassword.length === 64, String(page.data.newBackupPassword.length));
      wxCalls.length = 0;
      page.setData({ newBackupPassword: 'short7c' });
      await page.onSaveBackupPassword.call(page);
      check('少于 8 位备份密码被拒', wxCalls.some((c) => c[0] === 'showToast' && /至少 8 位/.test(c[1].title || '')));
      wxCalls.length = 0;
      page.setData({ newBackupPassword: 'make1234' });
      await page.onSaveBackupPassword.call(page);
      check('创建后标记备份密码已设置', page.data.backupPasswordConfigured === true, String(page.data.backupPasswordConfigured));
      check('创建成功使用创建文案', wxCalls.some((c) => c[0] === 'showModal' && c[1].title === '备份密码已创建'));
      const createdModal = wxCalls.find((c) => c[0] === 'showModal' && c[1].title === '备份密码已创建');
      if (createdModal && createdModal[1].success) createdModal[1].success({ confirm: true });
      check('确认创建后返回来源页', page.data.directBackupPasswordCreate === false && wxCalls.some((c) => c[0] === 'navigateBack'));
      page.onBackupPasswordEntry.call(page);
      check('后续点击进入修改表单', page.data.backupPasswordExpanded === true && page.data.backupPasswordConfigured === true);
      page.setData({ oldBackupPassword: 'make1234', newBackupPassword: 'change567', confirmBackupPassword: 'change567' });
      wxCalls.length = 0;
      await page.onSaveBackupPassword.call(page);
      check('修改后使用修改文案', wxCalls.some((c) => c[0] === 'showModal' && c[1].title === '备份密码已修改'));
      check('修改后的备份密码可验证', store.verifyBackupPassword('change567'));
      await page.onRetention.call(page, { detail: { value: 2 } });
      await new Promise((r) => setTimeout(r, 10));
      check('改保留期生效', store.getSettings().trashRetentionDays === 90, String(store.getSettings().trashRetentionDays));
      await page.onGeneration.call(page, { detail: { value: 1 } });
      await new Promise((r) => setTimeout(r, 10));
      check('改生成历史策略生效', store.getSettings().generationRetention === 'month');
      await page.onClipboardHint.call(page, { detail: { value: false } });
      await new Promise((r) => setTimeout(r, 10));
      check('改剪贴板提醒生效', store.getSettings().clipboardHint === false);
      themeApplyCount = 0;
      await page.onTheme.call(page, tap({ value: 'dark' }));
      await new Promise((r) => setTimeout(r, 10));
      check('改主题已持久化', store.getSettings().theme === 'dark');
      check('改主题同步全局视觉状态', themeApplyCount > 0, String(themeApplyCount));
      page.onSecurityNote.call(page);
      check('安全说明弹窗有内容', wxCalls.some((c) => c[0] === 'showModal' && /丢失风险/.test(c[1].content || '')));
    } catch (error) {
      check('设置', false, error.message);
    }
  }

  console.log('\n备份 backup');
  {
    try {
      const page = loadPage('backup');
      await page.onLoad.call(page, {});
      await new Promise((r) => setTimeout(r, 10));
      check('onLoad 不抛错', true);
      check('服务商信息载入', page.data.provider.name === '坚果云', JSON.stringify(page.data.provider.name));
      check('不自动追加默认目录', !page.data.config.directory, page.data.config.directory);
      page.setData({ viewMode: 'wechat' });
      check('提供微信文件导出方法', typeof page.onExportToWechat === 'function');
      check('提供全部 OTP 二维码导出方法', typeof page.onExportAllOtpQr === 'function');
      check('提供微信文件导入方法', typeof page.onImportFromWechat === 'function');
      check('不保留本地文件夹选择方法', typeof page.onChooseLocalFolder === 'undefined');
      check('不保留自动备份开关方法', typeof page.onToggleAutoBackup === 'undefined');
      page.onInput.call(page, input('me@example.com', { key: 'account' }));
      check('填账号生效', page.data.config.account === 'me@example.com');
      // 备份密码已不在备份页设置(统一收进设置页),直接模拟设置页写入后的状态来验 checkBackupPassword。
      // 这里的密码来自 store,是设置时校验过的值,所以备份页**不该**再套长度策略 ——
      // 否则提高下限之后,老用户存着的短密码会被拦住,连自己的备份都导不出。
      page.setData({ backupConfigured: true, backupPassword: 'abc' });
      wxCalls.length = 0;
      check('旧的短备份密码仍可用于导出/恢复', page.checkBackupPassword.call(page) === 'abc');
      page.setData({ backupPassword: 'valid1234' });
      check('正常长度备份密码通过', page.checkBackupPassword.call(page) === 'valid1234');
      page.setData({ backupPassword: '' });
      check('空密码通过(用户已显式确认过)', page.checkBackupPassword.call(page) === '');
      page.setData({ backupConfigured: false, backupPassword: 'valid1234' });
      check('未设置备份密码时跳去设置页', page.checkBackupPassword.call(page) === null);
      page.setData({ backupConfigured: true, backupPassword: 'valid1234' });
      wxCalls.length = 0;
      await page.onExportToWechat.call(page);
      check('导出调用微信文件转发', wxCalls.some((c) => c[0] === 'shareFileMessage'));
      wxCalls.length = 0;
      page.onExportAllOtpQr.call(page);
      check('全部 OTP 二维码入口跳转迁移页', wxCalls.some((c) => c[0] === 'navigateTo' && /otp-bundle-transfer/.test(c[1].url)));
      wxCalls.length = 0;
      page.onImportFromWechat.call(page);
      check('导入调用微信文件选择器', wxCalls.some((c) => c[0] === 'chooseMessageFile'));

      // 真正跑一遍加密(低迭代数以外的路径都是真的)
      page.showBusy.call(page, '测试');
      check('进度遮罩打开', page.data.busy === true);
      page.updateBusy.call(page, 0.5);
      check('进度更新', page.data.busyPercent === 50, String(page.data.busyPercent));
      page.hideBusy.call(page);
      check('进度遮罩关闭', page.data.busy === false);

      wxCalls.length = 0;
      page.onUpload.call(page);
      await new Promise((r) => setTimeout(r, 10));
      check('未配置应用密码时上传被挡', wxCalls.some((c) => c[0] === 'showToast' && /配置/.test(c[1].title || '')));
    } catch (error) {
      check('备份', false, error.message);
    }
  }

  console.log('\n' + '='.repeat(46));
  console.log(fail === 0 ? `全部通过 (${pass}/${pass})` : `通过 ${pass} / 失败 ${fail}`);
  if (problems.length) {
    console.log('\n失败清单:');
    problems.forEach((p) => console.log('  · ' + p));
  }
  process.exit(fail === 0 ? 0 : 1);
})();
