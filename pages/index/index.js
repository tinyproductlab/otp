const store = require('../../utils/store.js');
const totp = require('../../utils/totp.js');
const tokenView = require('../../utils/token-view.js');
const dragSort = require('../../utils/drag-sort.js');
const otpExport = require('../../utils/otp-export.js');
const otpTransfer = require('../../utils/otp-transfer.js');
const otpBundleTransfer = require('../../utils/otp-bundle-transfer.js');
const i18n = require('../../utils/i18n.js');

const RETENTION_LABELS = { 7: '7 天', 30: '30 天', 90: '90 天', 0: '永久' };

/**
 * 顶栏标题跟着当前页走。
 * 三屏是同一个 Page 里的 swiper，顶栏在 swiper 外面，所以左右滑到别的屏时
 * 原来一直顶着 "OTP" —— 看着像没切换。标题必须跟着 current 变。
 * 文案与底部三栏保持一致，否则同一屏两个地方叫两个名字。
 */
const PANE_TITLES = i18n.home('zh-Hans').panes;
const BRAND_COLORS = ['#B87B68', '#6D86B8', '#9B8A5B', '#7D9B88', '#9A6BAA', '#B18C55'];

function brandColorFor(item) {
  const text = `${item.issuer || ''}${item.accountName || ''}`;
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return BRAND_COLORS[hash % BRAND_COLORS.length];
}

Page({
  data: {
    current: 1, // 默认落在首页,对齐安卓 openInitialPage() 固定进首页
    paneTitle: PANE_TITLES[1].title,
    paneSub: PANE_TITLES[1].sub,
    stats: { passwordCount: 0, otpCount: 0, trashCount: 0, webdavConfigured: false },
    security: {
      storage: { level: 'ok', text: '' },
      backup: { level: 'warn', text: '' },
      strength: { level: 'ok', text: '' },
    },
    backupSummary: '未配置坚果云',
    trashRetentionLabel: '30 天',
    pendingSync: false,
    tokens: [],
    keyword: '',
    searchActive: false,
    sort: 'time',
    filterVisible: false,
    revealedTokenId: "",
    addMenuVisible: false,
    moreMenuVisible: false,
    dragId: '',      // 正被拖动的卡片 id
    dragOffset: 0,   // 该卡片跟手的 translateY(px)
    copy: Object.assign({}, i18n.home('zh-Hans'), i18n.otp('zh-Hans')),
  },

  /** 长按拖排。只在手动排序模式下启用。 */
  dragger() {
    if (!this._dragger) {
      this._dragger = dragSort.createDragSort({
        selector: '.home-token',
        listKey: 'tokens',
        persist: (ids) => store.reorderOtpTokens(ids),
      });
    }
    return this._dragger;
  },

  onLoad() {
    getApp().ready().then(() => this.refresh());
    this.unsubscribe = store.subscribe(() => this.refresh());
    if (wx.showShareMenu) wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage', 'shareTimeline'] });
  },

  onShareAppMessage() {
    return {
      title: '密扫 OTP｜安全管理验证码与密码',
      path: '/pages/index/index',
      imageUrl: '/assets/otp-logo.jpg',
    };
  },

  onShareTimeline() {
    return {
      title: '密扫 OTP｜小产品实验室',
      query: 'from=timeline',
      imageUrl: '/assets/otp-logo.jpg',
    };
  },

  onShow() {
    if (getApp().globalData.ready) this.refresh();
    this.startTicking();
  },

  onHide() {
    this.stopTicking();
    // 拖到一半切走:丢弃这次拖动,不写库。回来时列表按存好的顺序重建。
    if (this.dragger().isDragging()) this.setData(this.dragger().cancel());
  },

  onUnload() {
    this.stopTicking();
    if (this.unsubscribe) this.unsubscribe();
  },

  startTicking() {
    this.stopTicking();
    this.timer = setInterval(() => this.tickTokens(), 1000);
  },

  stopTicking() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  refresh() {
    const stats = store.stats();
    const settings = store.getSettings();
    const copy = Object.assign({}, i18n.home(settings.locale), i18n.otp(settings.locale));
    const webdav = store.getWebdav();

    // 待同步 = 配了 WebDAV 但本地有改动还没传上去
    const pendingSync = stats.webdavConfigured && (!webdav.lastSyncAt || this.hasChangesSince(webdav.lastSyncAt));

    this.setData({
      stats,
      pendingSync,
      trashRetentionLabel: RETENTION_LABELS[settings.trashRetentionDays] || '30 天',
      backupSummary: this.describeBackup(stats, webdav),
      security: this.buildSecurity(stats, webdav),
      copy,
      paneTitle: copy.panes[this.data.current].title,
      paneSub: copy.panes[this.data.current].sub,
    });
    this.refreshTokens();
  },

  /** 懒建列表视图模型。首页的验证码默认盖成圆点,点了才显示明文。 */
  tokenList() {
    if (!this._tokenList) {
      this._tokenList = tokenView.createTokenList({
        masked: true,
        decorate: (item) => ({ brandColor: brandColorFor(item) }),
      });
    }
    return this._tokenList;
  },

  sortedSource() {
    const manual = this.data.sort === 'manual';
    const source = store.listOtpTokens(this.data.keyword || '', manual ? 'manual' : 'default').slice();
    if (this.data.sort === 'name') {
      // 用 store.compareTitle,别直接 localeCompare —— 只有它处理了
      // iOS(JavaScriptCore) 和安卓(V8) 的 ICU 差异,并且明确把西文排在中文前面。
      // 裸 localeCompare 会让中文跑到最前，且两端顺序可能不一致。
      source.sort((a, b) => store.compareTitle(
        `${a.issuer || ''} ${a.accountName || ''}`.trim(),
        `${b.issuer || ''} ${b.accountName || ''}`.trim()));
    }
    return source;
  },

  /** 全量重建。数据变化、搜索词或排序变化时调用,不要放进每秒的定时器。 */
  refreshTokens() {
    const tokens = this.tokenList().build(this.sortedSource(), Date.now(), this.data.revealedTokenId);
    this.setData({ tokens }, () => {
      // 行高要在列表渲染完之后量,拖动的换位阈值靠它
      if (this.data.sort === 'manual' && tokens.length > 1) this.dragger().measure(this);
    });
  },

  /** 每秒一次。只 setData 真正变化的字段 —— 详见 utils/token-view.js 顶部注释。 */
  tickTokens() {
    // 拖动中不刷新:tick 会重排数组、把手里那张卡片挪走
    if (this.dragger().isDragging()) return;
    const patch = this.tokenList().tick(this.data.tokens, Date.now(), this.data.revealedTokenId);
    if (patch === 'rebuild') {
      this.refreshTokens();
      return;
    }
    if (patch) this.setData(patch);
  },

  // ---- 长按拖动排序 ----

  onTokenDragMove(event) {
    if (!this.dragger().isDragging()) return;
    const patch = this.dragger().move(this.data.tokens, event.touches && event.touches[0]);
    if (patch) this.setData(patch);
  },

  onTokenDragEnd() {
    if (!this.dragger().isDragging()) return;
    const { patch, save } = this.dragger().end(this.data.tokens);
    if (patch) this.setData(patch);
    // 松手后系统还会补一个 tap,不挡住的话会顺手把验证码复制出去
    this._dragEndedAt = Date.now();
    save.catch((error) => {
      wx.showToast({ title: '顺序保存失败：' + (error && error.message ? error.message : '未知错误'), icon: 'none' });
      this.refreshTokens();
    });
  },

  /** 刚拖完的那一下 tap 要忽略 */
  justDragged() {
    return this.dragger().isDragging() || (Date.now() - (this._dragEndedAt || 0) < 350);
  },

  hasChangesSince(timestamp) {
    const newest = store.state.passwords
      .concat(store.state.otpTokens)
      .reduce((max, item) => Math.max(max, item.updatedAt || 0), 0);
    return newest > timestamp;
  },

  describeBackup(stats, webdav) {
    if (!stats.webdavConfigured) return '未配置坚果云 · 可先用本地导出';
    if (!webdav.lastSyncAt) return '坚果云已配置 · 还没备份过';
    const days = Math.floor((Date.now() - webdav.lastSyncAt) / 86400000);
    if (days === 0) return '坚果云 · 今天已备份';
    return `坚果云 · ${days} 天前备份`;
  },

  /** 三行安全状态。文案对齐安卓 primary_security_status,但去掉了不适用的项。 */
  buildSecurity(stats, webdav) {
    const storage = { level: 'ok', text: '本地数据已加密存储' };

    let backup;
    if (!webdav.lastSyncAt) {
      backup = { level: 'bad', text: '还没有任何备份 —— 换手机或清缓存会丢数据' };
    } else {
      const days = Math.floor((Date.now() - webdav.lastSyncAt) / 86400000);
      backup = days > 14
        ? { level: 'warn', text: `上次备份在 ${days} 天前,建议尽快备份` }
        : { level: 'ok', text: `上次备份 ${days === 0 ? '今天' : days + ' 天前'}` };
    }

    let strength;
    if (stats.passwordCount === 0) {
      strength = { level: 'ok', text: '还没有保存密码' };
    } else if (stats.weakCount > 0 || stats.duplicateCount > 0) {
      const parts = [];
      if (stats.weakCount > 0) parts.push(`${stats.weakCount} 个弱密码`);
      if (stats.duplicateCount > 0) parts.push(`${stats.duplicateCount} 个重复密码`);
      strength = { level: 'warn', text: parts.join(' · ') };
    } else {
      strength = { level: 'ok', text: '所有密码强度良好' };
    }

    return { storage, backup, strength };
  },

  onPageChange(event) {
    this.showPane(event.detail.current);
  },

  onTab(event) {
    this.showPane(Number(event.currentTarget.dataset.index));
  },

  /** 切屏的唯一入口:滑动和点底栏都走这里,保证标题永远和内容对得上 */
  showPane(index) {
    const panes = (this.data.copy && this.data.copy.panes) || PANE_TITLES;
    const pane = panes[index] || panes[1];
    this.setData({ current: index, paneTitle: pane.title, paneSub: pane.sub });
  },

  // ---- 导航 ----

  // 下面这几个导航入口模板里没有绑定,只有 _test/verify-pages.js 的
  // 「8 个导航入口都能调用」在测。不是死代码,是入口没接上界面。
  onOpenOtp() { wx.navigateTo({ url: '/pages/otp/otp' }); },
  onOpenSecurityPlan() { wx.navigateTo({ url: '/pages/security-plan/security-plan' }); },
  onBackup() { wx.navigateTo({ url: '/pages/backup/backup?mode=home' }); },
  onExport() { wx.navigateTo({ url: '/pages/backup/backup?action=export' }); },

  onOpenPassword() { wx.navigateTo({ url: '/pages/password/password' }); },
  onManualOtp() {
    this.onCloseAddMenu();
    wx.navigateTo({ url: '/pages/otp-edit/otp-edit' });
  },

  onAddMenu() {
    this.setData({ addMenuVisible: true, searchActive: false, keyword: "", filterVisible: false });
  },

  onCloseAddMenu() {
    this.setData({ addMenuVisible: false });
  },

  noop() {},

  onBatchImport() {
    this.onCloseAddMenu();
    wx.showActionSheet({
      itemList: ['粘贴 TXT / JSON / Google 内容', '选择导入文件'],
      success: (res) => {
        if (res.tapIndex === 0) this.openOtpPasteImport();
        else this.openOtpFileImport();
      },
      fail: () => {},
    });
  },

  openOtpPasteImport() {
    wx.showModal({
      title: '批量导入 OTP',
      editable: true,
      placeholderText: '粘贴 otpauth://、JSON 或 Google Authenticator 内容',
      confirmText: '导入',
      success: async (res) => {
        if (!res.confirm || !res.content) return;
        await this.importOtpText(res.content);
      },
    });
  },

  openOtpFileImport() {
    if (!wx.chooseMessageFile) {
      wx.showToast({ title: '当前基础库不支持选文件', icon: 'none' });
      return;
    }
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        wx.getFileSystemManager().readFile({
          filePath: file.path,
          encoding: 'utf8',
          success: async (read) => this.importOtpText(read.data),
          fail: () => wx.showToast({ title: '读取文件失败', icon: 'none' }),
        });
      },
      fail: () => {},
    });
  },

  async importOtpText(text) {
    let tokens;
    try {
      tokens = otpExport.parseImportText(text);
    } catch (error) {
      wx.showModal({ title: '导入失败', content: error.message || '无法识别 TXT、JSON 或 Google 格式', showCancel: false });
      return;
    }
    let added = 0;
    let duplicate = 0;
    let invalid = 0;
    for (const token of tokens) {
      try {
        await store.saveOtpToken(token);
        added++;
      } catch (error) {
        if (error && error.code === 'DUPLICATE') duplicate++;
        else invalid++;
      }
    }
    this.refresh();
    wx.showModal({
      title: '批量导入完成',
      content: `成功 ${added} 条${duplicate ? `，重复 ${duplicate} 条` : ''}${invalid ? `，无效 ${invalid} 条` : ''}`,
      showCancel: false,
    });
  },

  onExportOtp() {
    this.onCloseAddMenu();
    const tokens = store.listOtpTokens();
    if (!tokens.length) {
      wx.showToast({ title: '暂无可导出的 OTP', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: ['加密迁移二维码（全部）', 'TXT（otpauth）', 'JSON', 'Google Authenticator'],
      success: (res) => {
        if (res.tapIndex === 0) {
          wx.navigateTo({ url: '/pages/otp-bundle-transfer/otp-bundle-transfer' });
          return;
        }
        const formats = ['txt', 'json', 'google'];
        this.writeOtpExport(tokens, formats[res.tapIndex - 1]);
      },
      fail: () => {},
    });
  },

  writeOtpExport(tokens, format) {
    const content = format === 'json'
      ? otpExport.toJson(tokens)
      : format === 'google' ? otpExport.toGoogleMigration(tokens) : otpExport.toUriLines(tokens);
    const extension = format === 'json' ? 'json' : 'txt';
    const name = `密扫-OTP-${Date.now()}.${extension}`;
    const path = `${wx.env.USER_DATA_PATH}/${name}`;
    try {
      wx.getFileSystemManager().writeFileSync(path, content, 'utf8');
    } catch (error) {
      wx.showModal({ title: '导出失败', content: error.message || '无法写入导出文件', showCancel: false });
      return;
    }
    if (!wx.shareFileMessage) {
      wx.setClipboardData({ data: content, success: () => wx.showToast({ title: '已复制导出内容', icon: 'success' }) });
      return;
    }
    wx.shareFileMessage({
      filePath: path,
      fileName: name,
      success: () => wx.showToast({ title: '导出文件已生成', icon: 'success' }),
      fail: (error) => {
        if (error && /cancel/i.test(error.errMsg || '')) return;
        wx.showModal({ title: '分享失败', content: '文件已生成，可重新点击导出后分享。', showCancel: false });
      },
    });
  },

  onOtpTouchStart(event) {
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    this.otpTouchStart = { x: touch.clientX, y: touch.clientY };
    this.otpTouchLast = this.otpTouchStart;
  },

  onOtpTouchMove(event) {
    const touch = event.touches && event.touches[0];
    if (touch) this.otpTouchLast = { x: touch.clientX, y: touch.clientY };
  },

  onOtpTouchEnd(event) {
    const start = this.otpTouchStart;
    const touch = (event.changedTouches && event.changedTouches[0]) || this.otpTouchLast;
    this.otpTouchStart = null;
    this.otpTouchLast = null;
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dy) < 36 || Math.abs(dy) < Math.abs(dx) * 1.15) return;
    if (dy > 0) this.revealHomeSearch();
    else this.onAddMenu();
  },

  revealHomeSearch() {
    this.setData({ searchActive: true });
  },

  onHomeSearch(event) {
    this.setData({ keyword: event.detail.value }, () => this.refreshTokens());
  },

  onToggleFilter() {
    this.setData({ filterVisible: !this.data.filterVisible });
  },

  onSelectSort(event) {
    this.setData({
      sort: event.currentTarget.dataset.sort,
      filterVisible: false,
    }, () => this.refreshTokens());
  },

  onClearHomeSearch() {
    this.setData({ keyword: '' }, () => this.refreshTokens());
  },

  onTokenEdit(event) {
    if (this.justDragged()) return;
    wx.navigateTo({ url: '/pages/otp-edit/otp-edit?id=' + event.currentTarget.dataset.id });
  },

  onTokenCopy(event) {
    if (this.justDragged()) return;
    const id = event.currentTarget.dataset.id;
    const token = this.data.tokens.find((item) => item.id === id);
    // 纯数字验证码从 JS 侧的 runtime 表取,不放在 data 里 —— 没必要过桥给渲染层
    const rawCode = this.tokenList().codeOf(id);
    if (!token || !rawCode) {
      wx.showToast({ title: "这个验证码的密钥有问题", icon: "none" });
      return;
    }
    // 展开明文只影响 display 一个字段,用定向补丁而不是重建整个列表
    this.setData(Object.assign(
      { revealedTokenId: id },
      this.tokenList().displayPatch(this.data.tokens, id) || {}
    ));
    wx.setClipboardData({
      data: rawCode,
      success: () => wx.showToast({ title: `已复制 · ${token.remaining} 秒后失效`, icon: "none", duration: 2000 }),
    });
  },

  onTokenLongPress(event) {
    const id = event.currentTarget.dataset.id;
    const token = this.data.tokens.find((item) => item.id === id);
    if (!token) return;

    // 手动排序模式下,长按是"抓起来拖",不弹操作表 ——
    // 其余排序方式下顺序由规则决定,拖了也留不住,所以只在手动模式启用。
    if (this.data.sort === 'manual' && this.data.tokens.length > 1) {
      const patch = this.dragger().start(this.data.tokens, id, event.touches && event.touches[0]);
      if (patch) {
        this.setData(patch);
        if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
      }
      return;
    }

    // pinned 是逻辑层状态,渲染层用不到,所以从 runtime 表取原始令牌
    const raw = this.tokenList().itemOf(id);
    wx.showActionSheet({
      itemList: [raw && raw.pinned ? '取消置顶' : '置顶', '编辑', '生成迁移二维码', '删除'],
      success: async (res) => {
        if (res.tapIndex === 0) await store.toggleOtpPinned(token.id);
        else if (res.tapIndex === 1) wx.navigateTo({ url: '/pages/otp-edit/otp-edit?id=' + token.id });
        else if (res.tapIndex === 2) {
          wx.navigateTo({ url: '/pages/otp-transfer/otp-transfer?id=' + token.id });
          return;
        } else if (res.tapIndex === 3) await store.deleteOtpToken(token.id);
        this.refresh();
      },
      fail: () => {},
    });
  },

  onMore() {
    this.setData({ moreMenuVisible: true });
  },

  onCloseMoreMenu() {
    this.setData({ moreMenuVisible: false });
  },

  onLanguage() {
    this.onCloseMoreMenu();
    const labels = i18n.LOCALE_OPTIONS.map((item) => item.label);
    wx.showActionSheet({
      itemList: labels,
      success: async (res) => {
        const option = i18n.LOCALE_OPTIONS[res.tapIndex] || i18n.LOCALE_OPTIONS[0];
        await store.updateSettings({ locale: option.value });
        const applied = getApp().applyLocale ? getApp().applyLocale() : option.value;
        this.refresh();
        wx.showToast({
          title: option.value === 'system' ? `已跟随系统（${applied}）` : `已切换为 ${option.label}`,
          icon: 'none',
        });
      },
      fail: () => {},
    });
  },

  onFeedback() {
    this.onCloseMoreMenu();
  },

  onAbout() {
    this.onCloseMoreMenu();
    wx.navigateTo({ url: '/pages/about/about' });
  },
  onGenerator() { wx.navigateTo({ url: '/pages/generator/generator' }); },
  onQrCode() { wx.navigateTo({ url: '/pages/qrcode/qrcode' }); },

  onWebdavConfig() { wx.navigateTo({ url: '/pages/backup/backup?mode=config' }); },
  onCloudBackup() { wx.navigateTo({ url: '/pages/backup/backup?mode=cloud' }); },
  onLocalBackup() { wx.navigateTo({ url: '/pages/backup/backup?mode=wechat' }); },
  onTrash() { wx.navigateTo({ url: '/pages/trash/trash' }); },
  onSettings() {
    this.onCloseMoreMenu();
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  /**
   * 扫码添加 TOTP。wx.scanCode 是原生能力,比安卓自己搓 CameraX + MLKit 省事得多。
   * onlyFromCamera: false —— 允许从相册选,用户常把二维码截图存下来。
   */
  onScan() {
    this.onCloseAddMenu();
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode'],
      success: async (res) => {
        const raw = res.result || '';
        if (otpBundleTransfer.isBundlePayload(raw)) {
          wx.navigateTo({ url: '/pages/otp-bundle-transfer/otp-bundle-transfer?mode=import&payload=' + encodeURIComponent(raw) });
          return;
        }
        if (otpTransfer.isTransferPayload(raw)) {
          wx.navigateTo({ url: '/pages/otp-transfer/otp-transfer?mode=import&payload=' + encodeURIComponent(raw) });
          return;
        }
        let token;
        try {
          token = totp.parseUri(raw);
        } catch (error) {
          wx.showModal({
            title: '无法识别',
            content: (error.message || '这不是 TOTP 二维码') + '\n\n请扫描各网站「双重验证」页面里的二维码。',
            showCancel: false,
          });
          return;
        }
        try {
          await store.saveOtpToken(token);
          wx.showToast({ title: '已添加 ' + (token.issuer || token.accountName), icon: 'success' });
          this.refresh();
        } catch (error) {
          if (error.code === 'DUPLICATE') {
            wx.showToast({ title: '这个验证码已存在', icon: 'none' });
            this.refresh();
            return;
          }
          wx.showToast({ title: error.message || '添加失败', icon: 'none' });
        }
      },
      fail: (err) => {
        // 用户主动取消不该报错
        if (err && /cancel/i.test(err.errMsg || '')) return;
        wx.showToast({ title: '扫码未完成', icon: 'none' });
      },
    });
  },
});
