const store = require('../../utils/store.js');
const tokenView = require('../../utils/token-view.js');
const dragSort = require('../../utils/drag-sort.js');
const i18n = require('../../utils/i18n.js');

Page({
  data: {
    tokens: [],
    keyword: '',
    sort: 'time',
    filterVisible: false,
    dragId: '',      // 正被拖动的卡片 id
    dragOffset: 0,   // 该卡片跟手的 translateY(px)
    copy: i18n.otp('zh-Hans'),
  },

  /** 长按拖排。只在手动排序模式下启用。 */
  dragger() {
    if (!this._dragger) {
      this._dragger = dragSort.createDragSort({
        selector: '.token',
        listKey: 'tokens',
        persist: (ids) => store.reorderOtpTokens(ids),
      });
    }
    return this._dragger;
  },

  onLoad() {
    getApp().ready().then(() => {
      this.setData({ copy: i18n.otp(store.getSettings().locale) });
      this.refresh();
    });
    this.unsubscribe = store.subscribe(() => this.refresh());
  },

  onShow() {
    if (getApp().globalData.ready) {
      this.setData({ copy: i18n.otp(store.getSettings().locale) });
      this.refresh();
    }
    this.startTicking();
  },

  onHide() {
    this.stopTicking();
    // 拖到一半切走:丢弃这次拖动,不写库
    if (this.dragger().isDragging()) this.setData(this.dragger().cancel());
  },

  onUnload() {
    this.stopTicking();
    if (this.unsubscribe) this.unsubscribe();
  },

  /**
   * 每秒刷新一次。
   * 只在页面可见时跑 —— 小程序没有后台执行,页面隐藏时定时器留着纯属浪费。
   */
  startTicking() {
    this.stopTicking();
    // 每秒走增量的 tick,不是全量 refresh —— 全量会把整个列表重新过一遍桥
    this.timer = setInterval(() => this.tick(), 1000);
  },

  stopTicking() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  tokenList() {
    // 列表页直接显示明文验证码,不做遮盖
    if (!this._tokenList) this._tokenList = tokenView.createTokenList({ masked: false });
    return this._tokenList;
  },

  sortedSource() {
    const manual = this.data.sort === 'manual';
    const source = store.listOtpTokens(this.data.keyword, manual ? 'manual' : 'default').slice();
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

  /** 全量重建:数据、搜索词或排序变化时调用 */
  refresh() {
    const tokens = this.tokenList().build(this.sortedSource());
    this.setData({ tokens }, () => {
      // 行高要在列表渲染完之后量,拖动的换位阈值靠它
      if (this.data.sort === 'manual' && tokens.length > 1) this.dragger().measure(this);
    });
  },

  // ---- 长按拖动排序 ----

  onDragMove(event) {
    if (!this.dragger().isDragging()) return;
    const patch = this.dragger().move(this.data.tokens, event.touches && event.touches[0]);
    if (patch) this.setData(patch);
  },

  onDragEnd() {
    if (!this.dragger().isDragging()) return;
    const { patch, save } = this.dragger().end(this.data.tokens);
    if (patch) this.setData(patch);
    // 松手后系统还会补一个 tap,不挡住的话会顺手把验证码复制出去
    this._dragEndedAt = Date.now();
    save.catch((error) => {
      wx.showToast({ title: '顺序保存失败：' + (error && error.message ? error.message : '未知错误'), icon: 'none' });
      this.refresh();
    });
  },

  /** 刚拖完的那一下 tap 要忽略 */
  justDragged() {
    return this.dragger().isDragging() || (Date.now() - (this._dragEndedAt || 0) < 350);
  },

  /** 每秒一次:只 setData 变化了的字段,详见 utils/token-view.js */
  tick() {
    // 拖动中不刷新:tick 会重排数组、把手里那张卡片挪走
    if (this.dragger().isDragging()) return;
    const patch = this.tokenList().tick(this.data.tokens);
    if (patch === 'rebuild') {
      this.refresh();
      return;
    }
    if (patch) this.setData(patch);
  },

  onSearch(event) {
    this.setData({ keyword: event.detail.value }, () => this.refresh());
  },

  onClearSearch() {
    this.setData({ keyword: '' }, () => this.refresh());
  },

  onToggleFilter() {
    this.setData({ filterVisible: !this.data.filterVisible });
  },

  onSelectSort(event) {
    this.setData({
      sort: event.currentTarget.dataset.sort,
      filterVisible: false,
    }, () => this.refresh());
  },

  noop() {},

  onCopy(event) {
    if (this.justDragged()) return;
    const id = event.currentTarget.dataset.id;
    const token = this.data.tokens.find((item) => item.id === id);
    // 从 runtime 表取纯数字码,不再靠"把 display 里的空格去掉"反推 ——
    // display 是给人看的格式,一旦改了展示方式(比如遮盖)那种反推就悄悄坏掉
    const code = this.tokenList().codeOf(id);
    if (!token || !code) {
      wx.showToast({ title: '这个验证码的密钥有问题', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: code,
      success: () => {
        // 小程序会自己弹"内容已复制",这里补一句剩余时间,更有用
        wx.showToast({
          title: `已复制 · ${token.remaining} 秒后失效`,
          icon: 'none',
          duration: 2000,
        });
      },
    });
  },

  onEdit(event) {
    wx.navigateTo({ url: '/pages/otp-edit/otp-edit?id=' + event.currentTarget.dataset.id });
  },

  onLongPress(event) {
    const id = event.currentTarget.dataset.id;
    const token = this.data.tokens.find((item) => item.id === id);
    if (!token) return;

    // 手动排序模式下,长按是"抓起来拖",不弹操作表 ——
    // 其余排序方式下顺序由规则决定,拖了也留不住。
    if (this.data.sort === 'manual' && this.data.tokens.length > 1) {
      const patch = this.dragger().start(this.data.tokens, id, event.touches && event.touches[0]);
      if (patch) {
        this.setData(patch);
        if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
      }
      return;
    }

    // pinned 是逻辑层状态,渲染层用不到,从 runtime 表取原始令牌
    const raw = this.tokenList().itemOf(id);

    wx.showActionSheet({
      itemList: [raw && raw.pinned ? '取消置顶' : '置顶', '编辑', '删除'],
      success: async (res) => {
        if (res.tapIndex === 0) {
          await store.toggleOtpPinned(id);
          this.refresh();
        } else if (res.tapIndex === 1) {
          this.onEdit(event);
        } else if (res.tapIndex === 2) {
          this.confirmDelete(token);
        }
      },
      fail: () => {},
    });
  },

  confirmDelete(token) {
    wx.showModal({
      title: '删除验证码',
      content: `「${token.issuer || token.accountName}」将移入回收站。\n\n注意:如果你在对应网站上还开着两步验证,删除后将无法登录。请先确认有其他验证方式。`,
      confirmText: '删除',
      confirmColor: '#D93025',
      success: async (res) => {
        if (!res.confirm) return;
        await store.deleteOtpToken(token.id);
        wx.showToast({ title: '已移入回收站', icon: 'none' });
        this.refresh();
      },
    });
  },

  onManual() {
    wx.navigateTo({ url: '/pages/otp-edit/otp-edit' });
  },

});
