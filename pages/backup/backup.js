const store = require('../../utils/store.js');
const backup = require('../../utils/backup.js');
const webdav = require('../../utils/webdav.js');

function formatTime(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatSize(bytes) {
  if (!bytes) return '—';
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

Page({
  data: {
    provider: {},
    config: { url: 'https://dav.jianguoyun.com/dav', account: '', appPassword: '' },
    backupPassword: '',
    backupPasswordDraft: '',
    uploadSummary: '',
    remoteSummary: '点击拉取坚果云上的备份列表',
    remoteBackups: [],
    busy: false,
    busyTitle: '',
    busyPercent: 0,
    requestBusy: false,
    viewMode: 'home',
    webdavConfigured: false,
    backupConfigured: false,
    trashCount: 0,
  },

  onLoad(query = {}) {
    this.pendingAction = query.action || '';
    const requestedMode = query.mode === 'local' ? 'wechat' : query.mode;
    this.setData({ viewMode: requestedMode || (this.pendingAction ? 'wechat' : 'home') });
    getApp().ready().then(() => {
      const config = store.getWebdav();
      this.setData({
        provider: webdav.provider(config.provider),
        config: {
          url: config.url || 'https://dav.jianguoyun.com/dav',
          account: config.account || '',
          appPassword: config.appPassword || '',
        },
        uploadSummary: config.lastSyncAt
          ? `上次备份 ${formatTime(config.lastSyncAt)}`
          : '还没有备份过',
        webdavConfigured: !!(config.account && config.appPassword),
        backupConfigured: store.isBackupPasswordConfigured(),
        backupPassword: store.getBackupPassword(),
        backupPasswordDraft: store.getBackupPassword(),
        trashCount: store.listTrash().length,
      }, () => {
        // 兼容旧深链：导出与导入仍直接进入微信文件传递页。
        if (this.pendingAction === 'import') wx.nextTick(() => this.onImportFromWechat());
        if (this.pendingAction === 'export') wx.nextTick(() => this.onExportToWechat());
      });
    });
  },

  openWebdavConfig() { this.setData({ viewMode: 'config' }); },

  onShow() {
    // 从设置页设完备份口令返回时，重新读取持久化状态，避免使用旧口令。
    if (!getApp().globalData.ready) return;
    this.setData({
      backupConfigured: store.isBackupPasswordConfigured(),
      backupPassword: store.getBackupPassword(),
    });
  },

  openCloudBackup() { this.setData({ viewMode: 'cloud' }); },
  openWechatTransfer() { this.setData({ viewMode: 'wechat' }); },
  openTrash() { wx.navigateTo({ url: '/pages/trash/trash' }); },

  onInput(event) {
    this.setData({ [`config.${event.currentTarget.dataset.key}`]: event.detail.value });
  },

  // 已删除四个死 handler（onBackupPasswordInput/onSaveBackupPassword/onBackupPassword/onGenerateBackupPassword）：
  // 备份密码的设置流程已统一收进设置页。其中 onBackupPassword 是每敲一个字符就落盘的危险实现，
  // 千万不要原样绑回去 —— 改密码必须走草稿+确认，见设置页的实现。

  async onSaveConfig() {
    const config = Object.assign({}, store.getWebdav(), this.data.config, {
      url: String(this.data.config.url || '').trim(),
      account: String(this.data.config.account || '').trim(),
      appPassword: String(this.data.config.appPassword || '').trim(),
    });
    this.setData({ config });
    if (!this.checkWebdavConfig()) return;
    await store.updateWebdav(config);
    const saved = store.getWebdav();
    this.setData({ config: saved, webdavConfigured: !!(saved.account && saved.appPassword) });
    wx.showToast({ title: '已保存', icon: 'success' });
  },

  beginRequest() {
    if (this.data.requestBusy) { wx.showToast({ title: "正在处理中，请稍候", icon: "none" }); return false; }
    this.setData({ requestBusy: true });
    return true;
  },

  endRequest() { this.setData({ requestBusy: false }); },

  // ---- 配置 ----

  checkWebdavConfig() {
    const url = String(this.data.config.url || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      wx.showToast({ title: "请填写正确的 WebDAV 地址", icon: "none" });
      return false;
    }
    return true;
  },

  async onTest() {
    if (!this.checkWebdavConfig()) return;
    if (!this.data.config.account || !this.data.config.appPassword) {
      wx.showToast({ title: "请先填账号和应用密码", icon: "none" });
      return;
    }
    if (!this.beginRequest()) return;
    wx.showLoading({ title: "正在连接…", mask: true });
    try {
      await webdav.testConnection(this.data.config);
      wx.hideLoading();
      await store.updateWebdav(this.data.config);
      this.endRequest();
      wx.showModal({ title: "连接成功", content: "账号和文件夹都没问题,配置已保存。", showCancel: false });
    } catch (error) {
      wx.hideLoading();
      this.endRequest();
      wx.showModal({ title: "连接失败", content: error.message || "未知错误", showCancel: false });
    }
  },

  // ---- 进度 ----

  showBusy(title) {
    this.setData({ busy: true, busyTitle: title, busyPercent: 0 });
  },

  updateBusy(ratio) {
    const percent = Math.round(ratio * 100);
    // 只在整数百分比变化时 setData,否则一秒几十次刷新反而更卡
    if (percent !== this.data.busyPercent) this.setData({ busyPercent: percent });
  },

  hideBusy() {
    this.setData({ busy: false, busyPercent: 0 });
  },

  /** 备份密码的统一校验 */
  checkBackupPassword() {
    const password = this.data.backupPassword;
    if (!this.data.backupConfigured) {
      wx.navigateTo({ url: '/pages/settings/settings?mode=createBackupPassword' });
      return null;
    }
    if (typeof password !== 'string') return null;
    // 这里的密码来自 store.getBackupPassword(),是设置时已经校验过的值,
    // 不是用户现场输入。所以**不能**在这里再套一遍长度策略 ——
    // 策略提高下限之后,老用户存着的短密码会被拦住,连自己的备份都导不出、恢复不了。
    // 新密码的强度要求在设置页把关(store.checkBackupPasswordLength)。
    return password;
  },

  async buildContainer(title) {
    const password = this.checkBackupPassword();
    if (password === null) return null;
    this.showBusy(title);
    try {
      const container = await backup.encrypt(store.snapshot(), password, {
        onProgress: (ratio) => this.updateBusy(ratio),
      });
      this.hideBusy();
      return container;
    } catch (error) {
      this.hideBusy();
      wx.showModal({ title: '加密失败', content: error.message || '未知错误', showCancel: false });
      return null;
    }
  },

  // ---- 上传 ----

  async onUpload() {
    // 页面可能在配置页返回后仍持有旧 data，点击备份时以持久化配置为准。
    const saved = store.getWebdav();
    const config = Object.assign({}, this.data.config, saved, {
      url: String(saved.url || this.data.config.url || '').trim(),
      account: String(saved.account || this.data.config.account || '').trim(),
      appPassword: String(saved.appPassword || this.data.config.appPassword || '').trim(),
    });
    this.setData({ config, webdavConfigured: !!(config.account && config.appPassword) });
    if (!this.checkWebdavConfig()) return;
    if (!config.account || !config.appPassword) {
      wx.showToast({ title: '请先配置坚果云账号和应用密码', icon: 'none' });
      return;
    }
    if (!this.beginRequest()) return;
    const container = await this.buildContainer("正在加密…");
    if (!container) { this.endRequest(); return; }
    const name = backup.suggestFilename();
    wx.showLoading({ title: "正在上传…", mask: true });
    try {
      await webdav.uploadBackup(config, name, container, { maxKeep: 20 });
      wx.hideLoading();
      await store.updateWebdav(Object.assign({}, config, { lastSyncAt: Date.now(), lastBackupName: name }));
      this.endRequest();
      this.setData({ uploadSummary: `上次备份 ${formatTime(Date.now())}` });
      wx.showModal({ title: "备份完成", content: `已上传 ${name}(${formatSize(container.length)})到坚果云。`, showCancel: false });
    } catch (error) {
      wx.hideLoading();
      this.endRequest();
      wx.showModal({ title: "上传失败", content: error.message || "未知错误", showCancel: false });
    }
  },

  // ---- 微信文件导出 ----

  async onExportToWechat() {
    const container = await this.buildContainer('正在加密…');
    if (!container) return;

    const name = backup.suggestFilename();
    const path = `${wx.env.USER_DATA_PATH}/${name}`;
    try {
      // 文件仅作为临时加密容器写入小程序沙箱，随后通过微信文件转发完成导出。
      wx.getFileSystemManager().writeFileSync(
        path,
        container.buffer.slice(container.byteOffset, container.byteOffset + container.length)
      );
    } catch (error) {
      wx.showModal({ title: '创建导出文件失败', content: String(error), showCancel: false });
      return;
    }

    wx.shareFileMessage({
      filePath: path,
      fileName: name,
      success: () => wx.showToast({ title: '已发送至微信', icon: 'success' }),
      fail: (err) => {
        if (err && /cancel/i.test(err.errMsg || '')) return;
        wx.showModal({
          title: '导出失败',
          content: '请确认已允许小程序使用微信文件转发功能，然后重试。',
          showCancel: false,
        });
      },
    });
  },

  onExportAllOtpQr() {
    if (!store.listOtpTokens().length) {
      wx.showToast({ title: '暂无可导出的 OTP', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/otp-bundle-transfer/otp-bundle-transfer' });
  },

  onImportFromWechat() {
    const password = this.checkBackupPassword();
    if (password === null) return;

    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['bak'],
      success: async (res) => {
        const selected = res.tempFiles && res.tempFiles[0];
        if (!selected || !selected.path) {
          wx.showToast({ title: '没有选择备份文件', icon: 'none' });
          return;
        }
        wx.showLoading({ title: '正在读取…', mask: true });
        wx.getFileSystemManager().readFile({
          filePath: selected.path,
          success: async (file) => {
            wx.hideLoading();
            const container = new Uint8Array(file.data);
            if (!backup.isContainer(container)) {
              wx.showModal({
                title: '不是 OTP 备份文件',
                content: '请选择从「小产品实验室 OTP」导出的 .bak 加密文件。',
                showCancel: false,
              });
              return;
            }
            await this.applyContainer(container, password);
          },
          fail: (error) => {
            wx.hideLoading();
            wx.showModal({ title: '读取文件失败', content: error.errMsg || '无法读取所选备份文件', showCancel: false });
          },
        });
      },
      fail: (error) => {
        if (error && /cancel/i.test(error.errMsg || '')) return;
        wx.showModal({ title: '选择文件失败', content: error.errMsg || '无法从微信选择备份文件', showCancel: false });
      },
    });
  },

  // ---- 恢复 ----

  async onRefreshRemote() {
    if (!this.data.config.account || !this.data.config.appPassword) {
      wx.showToast({ title: '请先配置坚果云', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '正在拉取…', mask: true });
    try {
      const list = await webdav.listBackups(this.data.config);
      wx.hideLoading();
      this.setData({
        remoteBackups: list.map((item) =>
          Object.assign({}, item, {
            timeText: formatTime(item.createdAt),
            sizeText: formatSize(item.size),
          })
        ),
        remoteSummary: list.length ? `坚果云上有 ${list.length} 份备份` : '坚果云上还没有备份',
      });
      if (!list.length) wx.showToast({ title: '还没有备份', icon: 'none' });
    } catch (error) {
      wx.hideLoading();
      wx.showModal({ title: '拉取失败', content: error.message || '未知错误', showCancel: false });
    }
  },

  onRestoreRemote(event) {
    const name = event.currentTarget.dataset.name;
    const password = this.checkBackupPassword();
    if (password === null) return;

    wx.showModal({
      title: '从坚果云恢复',
      content: `将合并 ${name} 里的数据到本地。\n\n合并规则:同一条记录取较新的那份,本地更新的内容不会被旧备份覆盖。`,
      confirmText: '开始恢复',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '正在下载…', mask: true });
        let container;
        try {
          container = await webdav.download(this.data.config, name);
          wx.hideLoading();
        } catch (error) {
          wx.hideLoading();
          wx.showModal({ title: '下载失败', content: error.message, showCancel: false });
          return;
        }
        await this.applyContainer(container, password);
      },
    });
  },

  onDeleteRemote(event) {
    const name = event.currentTarget.dataset.name;
    wx.showModal({
      title: '删除远端备份',
      content: `${name} 会从坚果云上删除,不可恢复。`,
      confirmText: '删除',
      confirmColor: '#D93025',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '正在删除…', mask: true });
        try {
          await webdav.deleteBackup(this.data.config, name);
          wx.hideLoading();
          wx.showToast({ title: '已删除', icon: 'success' });
          this.onRefreshRemote();
        } catch (error) {
          wx.hideLoading();
          wx.showModal({ title: '删除失败', content: error.message, showCancel: false });
        }
      },
    });
  },

  /** 解密并合并进本地 */
  async applyContainer(container, password) {
    this.showBusy('正在解密…');
    let snapshot;
    try {
      snapshot = await backup.decrypt(container, password, {
        onProgress: (ratio) => this.updateBusy(ratio),
      });
      this.hideBusy();
    } catch (error) {
      this.hideBusy();
      wx.showModal({ title: '恢复失败', content: error.message || '未知错误', showCancel: false });
      return;
    }

    try {
      const counts = await store.restoreSnapshot(snapshot);
      wx.showModal({
        title: '恢复完成',
        content: `密码 ${counts.passwords} 条、验证码 ${counts.otpTokens} 条、分组 ${counts.groups} 个已更新。`,
        showCancel: false,
      });
    } catch (error) {
      wx.showModal({ title: '写入失败', content: error.message || '未知错误', showCancel: false });
    }
  },

});
