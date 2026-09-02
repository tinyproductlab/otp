const store = require('../../utils/store.js');
const backup = require('../../utils/backup.js');
const i18n = require('../../utils/i18n.js');

const RETENTION_VALUES = [7, 30, 90, 0];
const GENERATION_VALUES = ['500', 'month'];

Page({
  data: {
    settings: {},
    stats: {},
    retentionLabels: [],
    retentionIndex: 1,
    generationLabels: [],
    generationIndex: 0,
    localeLabels: i18n.LOCALE_OPTIONS.map((item) => item.label),
    localeIndex: 0,
    copy: i18n.settings('zh-Hans'),
    themeNote: '',
    version: '1.0.0',
    storageText: '',
    backupPasswordConfigured: false,
    backupPasswordExpanded: false,
    oldBackupPassword: '',
    newBackupPassword: '',
    confirmBackupPassword: '',
    emptyBackupPasswordSelected: false,
    backupPasswordVisible: false,
    directBackupPasswordCreate: false,
  },

  onLoad(options) {
    this._directBackupPasswordCreateRequested = options && options.mode === 'createBackupPassword';
    this._focusBackupPassword = options && options.focus === 'backupPassword';
    // 先进入专用画面，避免数据加载期间短暂露出普通设置列表。
    if (this._directBackupPasswordCreateRequested) this.setData({ directBackupPasswordCreate: true });
    getApp().ready().then(() => this.refresh());
  },

  onShow() {
    if (getApp().globalData.ready) this.refresh();
  },

  refresh() {
    const settings = store.getSettings();
    const copy = i18n.settings(settings.locale);
    const retentionLabels = [copy.retentionWeek, copy.retentionMonth, copy.retentionQuarter, copy.retentionForever];
    const generationLabels = [copy.history500, copy.historyMonth];
    const backupPasswordConfigured = store.isBackupPasswordConfigured();
    const directBackupPasswordCreate = this._directBackupPasswordCreateRequested === true && !backupPasswordConfigured;
    const shouldFocusBackupPassword = this._focusBackupPassword === true && !directBackupPasswordCreate;
    this.setData({
      settings,
      stats: store.stats(),
      retentionLabels,
      generationLabels,
      retentionIndex: Math.max(0, RETENTION_VALUES.indexOf(settings.trashRetentionDays)),
      generationIndex: Math.max(0, GENERATION_VALUES.indexOf(settings.generationRetention)),
      localeIndex: i18n.optionIndex(settings.locale),
      copy,
      themeNote: settings.theme === 'light' ? copy.themeLight : settings.theme === 'dark' ? copy.themeDark : copy.themeSystem,
      backupPasswordConfigured,
      directBackupPasswordCreate,
      // 兼容其他设置深链；首次引导改由专用创建画面处理。
      backupPasswordExpanded: shouldFocusBackupPassword ? true : this.data.backupPasswordExpanded,
      emptyBackupPasswordSelected: backupPasswordConfigured && !store.getBackupPassword(),
    });
    if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: copy.pageTitle });
    if (shouldFocusBackupPassword) {
      this._focusBackupPassword = false;
      // 支持时平滑定位；不支持该接口时仍应直接展示创建表单，不能阻断引导。
      if (wx.nextTick && wx.pageScrollTo) {
        wx.nextTick(() => wx.pageScrollTo({ selector: '#backup-password-setting', duration: 200 }));
      }
    }
    this.applyTheme(settings.theme);
    this.refreshStorage();
  },

  refreshStorage() {
    if (typeof wx === 'undefined' || !wx.getStorageInfo) return;
    wx.getStorageInfo({
      success: (res) => {
        // 小程序总量上限 10MB。快到顶时要明确警告,否则写入会静默失败。
        const percent = Math.round((res.currentSize / res.limitSize) * 100);
        const copy = i18n.settings(store.getSettings().locale);
        const warn = percent >= 80 ? copy.storageWarning : '';
        this.setData({
          storageText: `${res.currentSize} KB / ${res.limitSize} KB(${percent}%)${warn}`,
        });
      },
      fail: () => this.setData({ storageText: i18n.settings(store.getSettings().locale).storageUnavailable }),
    });
  },

  async onTheme(event) {
    const theme = event.currentTarget.dataset.value;
    await store.updateSettings({ theme });
    const copy = i18n.settings(store.getSettings().locale);
    this.setData({ "settings.theme": theme, themeNote: theme === 'light' ? copy.themeLight : theme === 'dark' ? copy.themeDark : copy.themeSystem });
    this.applyTheme(theme);
  },

  applyTheme() {
    // WXSS 媒体查询只能跟随系统；由 App 解析保存的设置并同步页面根容器主题类。
    const app = getApp();
    if (app.applyTheme) app.applyTheme();
  },


  async onRetention(event) {
    const index = Number(event.detail.value);
    await store.updateSettings({ trashRetentionDays: RETENTION_VALUES[index] });
    this.refresh();
  },

  async onGeneration(event) {
    const index = Number(event.detail.value);
    await store.updateSettings({ generationRetention: GENERATION_VALUES[index] });
    this.refresh();
  },

  async onLocale(event) {
    const option = i18n.LOCALE_OPTIONS[Number(event.detail.value)] || i18n.LOCALE_OPTIONS[0];
    await store.updateSettings({ locale: option.value });
    const applied = getApp().applyLocale ? getApp().applyLocale() : option.value;
    this.refresh();
    // 文案逐页完成接入后，所有页面会读取这一值。当前页先明确反馈，避免用户误以为设置没有保存。
    wx.showToast({ title: option.value === 'system' ? `已跟随系统（${applied}）` : `已切换为 ${option.label}`, icon: 'none' });
  },

  onBiometric(event) {
    const enabled = Boolean(event.detail.value);
    if (!enabled) {
      store.updateSettings({ biometricLock: false }).then(() => this.refresh());
      return;
    }
    if (!wx.startSoterAuthentication) {
      this.setData({ "settings.biometricLock": false });
      wx.showToast({ title: "当前微信不支持生物识别", icon: "none" });
      return;
    }
    wx.startSoterAuthentication({
      requestAuthModes: ["fingerPrint", "facial"],
      challenge: "misao-otp-enable-biometric",
      success: () => store.updateSettings({ biometricLock: true }).then(() => this.refresh()),
      fail: () => {
        this.setData({ "settings.biometricLock": false });
        wx.showToast({ title: "未通过生物识别，未开启锁定", icon: "none" });
      },
    });
  },

  onCancelDirectBackupPassword() {
    this.exitDirectBackupPassword();
  },

  exitDirectBackupPassword() {
    this._directBackupPasswordCreateRequested = false;
    this.setData({ directBackupPasswordCreate: false });
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/index/index' });
  },

  // 注意:这个方法目前只有 _test/verify-pages.js 在调用,模板里没有入口。
  // 不是死代码,是功能写了但界面没接上 —— 要么补按钮,要么连测试一起删。
  onSecurityNote() {
    wx.showModal({
      title: '数据与安全',
      content:
        '存在哪:全部数据只存在你手机的微信本地存储里,不上传任何服务器。\n\n' +
        '怎么加密:本地存储开启了微信的加密存储;导出和上传坚果云的备份,用 AES-256-GCM 加密,密钥由你的备份密码经 ' +
        backup.DEFAULT_ITERATIONS.toLocaleString() +
        ' 次 PBKDF2 派生。坚果云看不到明文。\n\n' +
        '丢失风险:本地加密的密钥由微信托管并绑定设备。换手机、清理微信缓存、长期不用被清理,都可能导致数据无法解密。请务必定期导出备份 —— 这是唯一的保险。',
      showCancel: false,
      confirmText: '我知道了',
    });
  },

  onPrivacyPolicy() { wx.navigateTo({ url: '/pages/privacy/privacy' }); },
  onPermissionManagement() { wx.navigateTo({ url: '/pages/permissions/permissions' }); },

  onBackupPasswordEntry() {
    this.setData({ backupPasswordExpanded: !this.data.backupPasswordExpanded });
  },

  onOldBackupPassword(event) { this.setData({ oldBackupPassword: event.detail.value }); },
  onNewBackupPassword(event) {
    const value = String(event.detail.value || '').slice(0, store.BACKUP_PASSWORD_MAX);
    this.setData({ newBackupPassword: value, emptyBackupPasswordSelected: value.length === 0 ? this.data.emptyBackupPasswordSelected : false });
  },
  onConfirmBackupPassword(event) { this.setData({ confirmBackupPassword: String(event.detail.value || '').slice(0, store.BACKUP_PASSWORD_MAX) }); },
  onToggleBackupPasswordVisibility() {
    this.setData({ backupPasswordVisible: !this.data.backupPasswordVisible });
  },
  onEmptyBackupPassword(event) {
    const selected = Boolean(event.detail.value);
    this.setData({
      emptyBackupPasswordSelected: selected,
      newBackupPassword: selected ? '' : this.data.newBackupPassword,
      confirmBackupPassword: selected ? '' : this.data.confirmBackupPassword,
    });
  },

  onGenerateBackupPassword() {
    const password = store.generateBackupPassword(16);
    const modifying = this.data.backupPasswordConfigured;
    this.setData({
      newBackupPassword: password,
      confirmBackupPassword: modifying ? password : '',
      emptyBackupPasswordSelected: false,
      backupPasswordVisible: false,
    });
    wx.showModal({
      title: modifying ? '已生成新备份密码' : '已生成备份密码',
      content: `${password}\n\n请记录好。${modifying ? '修改完成后' : '创建完成后'}，恢复备份请使用此密码。`,
      showCancel: false,
    });
  },

  async onSaveBackupPassword() {
    const modifying = this.data.backupPasswordConfigured;
    const creating = !modifying;
    const directCreate = this.data.directBackupPasswordCreate === true && creating;
    const oldPassword = String(this.data.oldBackupPassword || '');
    const useEmptyPassword = Boolean(this.data.emptyBackupPasswordSelected);
    const nextPassword = useEmptyPassword ? '' : String(this.data.newBackupPassword || '');
    // 创建流程仅保留一个输入框；修改流程继续要求确认新密码。
    const confirmPassword = useEmptyPassword || creating ? nextPassword : String(this.data.confirmBackupPassword || '');
    if (modifying && !store.verifyBackupPassword(oldPassword)) {
      wx.showToast({ title: '旧备份密码不正确', icon: 'none' });
      return;
    }
    if (!useEmptyPassword && nextPassword !== confirmPassword) {
      wx.showToast({ title: '两次输入的新密码不一致', icon: 'none' });
      return;
    }
    if (nextPassword.length > 0) {
      const verdict = store.checkBackupPasswordLength(nextPassword);
      if (!verdict.ok) {
        wx.showToast({ title: verdict.message, icon: 'none' });
        return;
      }
    }
    if (nextPassword.length === 0) {
      wx.showModal({
        title: '确认使用空密码？',
        content: `空密码安全性较低。确认${modifying ? '修改' : '创建'}后，恢复备份请保持密码为空。`,
        // confirmText 最多 4 个字,超了 showModal 会直接 fail、弹不出来
        confirmText: '确认',
        confirmColor: '#D93025',
        success: async (res) => {
          if (!res.confirm) return;
          await store.confirmEmptyBackupPassword();
          this.setData({ backupPasswordConfigured: true, backupPasswordExpanded: false, backupPasswordVisible: false, oldBackupPassword: '', newBackupPassword: '', confirmBackupPassword: '' });
          wx.showModal({
            title: modifying ? '备份密码已修改' : '备份密码已创建',
            content: modifying ? '以后恢复备份请使用新的空密码。' : '以后恢复备份请保持密码为空。',
            showCancel: false,
            success: () => { if (directCreate) this.exitDirectBackupPassword(); },
          });
        },
      });
      return;
    }
    await store.updateBackupPassword(nextPassword);
    this.setData({ backupPasswordConfigured: true, backupPasswordExpanded: false, backupPasswordVisible: false, oldBackupPassword: '', newBackupPassword: '', confirmBackupPassword: '' });
    wx.showModal({
      title: modifying ? '备份密码已修改' : '备份密码已创建',
      content: modifying ? '以后恢复备份请使用新密码。使用旧密码将无法解密之后创建的备份。' : '以后恢复备份请使用此密码。请妥善保存，遗失后无法解密备份。',
      showCancel: false,
      success: () => { if (directCreate) this.exitDirectBackupPassword(); },
    });
  },

  async onClipboardHint(event) {
    await store.updateSettings({ clipboardHint: event.detail.value });
    this.refresh();
  },

  onStorageInfo() {
    wx.showModal({
      title: '存储占用',
      content:
        this.data.storageText +
        '\n\n小程序单个用户的存储上限是 10MB。密码和验证码都是纯文本,几百条也只占几百 KB,一般用不完。',
      showCancel: false,
    });
  },

  onClearAll() {
    wx.showModal({
      title: '清除全部本地数据',
      content: `将删除 ${this.data.stats.passwordCount} 条密码、${this.data.stats.otpCount} 个验证码和全部设置。\n\n此操作不可恢复。如果没有导出备份,数据将永久丢失。`,
      confirmText: '继续',
      confirmColor: '#D93025',
      success: (res) => {
        if (!res.confirm) return;
        // 二次确认:要求手动输入,防误触
        wx.showModal({
          title: '最后确认',
          editable: true,
          placeholderText: '输入「清除」两个字',
          confirmText: '确认清除',
          confirmColor: '#D93025',
          success: async (second) => {
            if (!second.confirm) return;
            if ((second.content || '').trim() !== '清除') {
              wx.showToast({ title: '输入不匹配,已取消', icon: 'none' });
              return;
            }
            try {
              wx.clearStorageSync();
            } catch (e) { /* 忽略 */ }
            store._reset();
            await store.ready();
            wx.showModal({
              title: '已清除',
              content: '全部本地数据已删除。',
              showCancel: false,
              success: () => wx.reLaunch({ url: '/pages/index/index' }),
            });
          },
        });
      },
    });
  },

});
