const store = require('../../utils/store.js');
const generator = require('../../utils/generator.js');
const random = require('../../utils/random.js');
const passwordStrategy = require('../../utils/password-strategy.js');

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

Page({
  data: {
    pickMode: false,
    password: '',
    strength: { level: 'weak', label: '较弱', score: 0 },
    options: Object.assign({}, generator.DEFAULT_OPTIONS),
    history: [],
    historyExpanded: false,
    historyRevealedId: '',
    lengthOptions: [4, 8, 12, 16, 20, 24, 32, 40, 48, 56, 64],
    lengthLabels: ['4 位', '8 位', '12 位', '16 位', '20 位', '24 位', '32 位', '40 位', '48 位', '56 位', '64 位'],
    lengthIndex: 3,
    strategies: passwordStrategy.list(),
    activeStrategy: 'daily',
    strategy: passwordStrategy.get('daily'),
  },

  onLoad(query = {}) {
    const strategy = passwordStrategy.get(query.strategy || 'daily');
    const lengthIndex = this.data.lengthOptions.indexOf(strategy.options.length);
    this.setData({
      pickMode: query.pick === '1',
      activeStrategy: strategy.id,
      strategy,
      options: strategy.options,
      lengthIndex: lengthIndex >= 0 ? lengthIndex : this.data.lengthIndex,
    });
    getApp()
      .ready()
      .then(() => {
        this.refreshHistory();
        this.generate(false); // 进页面先给一个,别让用户面对空白
      });
  },

  onShow() {
    if (getApp().globalData.ready) this.refreshHistory();
  },

  refreshHistory() {
    const revealedId = this.data.historyRevealedId;
    this.setData({
      history: store.listGenerations().slice(0, 30).map((item) =>
        Object.assign({}, item, {
          timeText: formatTime(item.createdAt),
          displayPassword: item.id === revealedId ? item.password : this.maskPassword(item.password),
        })
      ),
    });
  },

  maskPassword(password) {
    const value = String(password || '');
    if (value.length <= 4) return '••••';
    return `${value.slice(0, 2)}${'•'.repeat(Math.min(8, Math.max(4, value.length - 4)))}${value.slice(-2)}`;
  },

  onToggleHistory() {
    this.setData({ historyExpanded: !this.data.historyExpanded });
  },

  onSelectStrategy(event) {
    const strategy = passwordStrategy.get(event.currentTarget.dataset.id);
    const lengthIndex = this.data.lengthOptions.indexOf(strategy.options.length);
    this.setData({
      activeStrategy: strategy.id,
      strategy,
      options: strategy.options,
      lengthIndex: lengthIndex >= 0 ? lengthIndex : this.data.lengthIndex,
    }, () => this.generate(false));
  },

  onToggleHistoryItem(event) {
    const id = event.currentTarget.dataset.id;
    this.setData({ historyRevealedId: this.data.historyRevealedId === id ? '' : id }, () => this.refreshHistory());
  },

  /**
   * @param {boolean} record 是否写入历史。滑动长度时会频繁重算,那种不记。
   */
  async generate(record = true) {
    // 随机数没播种时先播种。理论上 app.onLaunch 已经做了,这里兜一层。
    try {
      await random.prefetch();
    } catch (error) {
      wx.showToast({ title: '系统随机数不可用', icon: 'none' });
      return;
    }

    const password = generator.generate(this.data.options);
    if (!password) {
      wx.showToast({ title: '至少要选一类字符', icon: 'none' });
      this.setData({ password: '', strength: { level: 'weak', label: '较弱', score: 0 } });
      return;
    }

    this.setData({ password, strength: generator.strengthLevel(password) });

    if (record) {
      await store.addGeneration(password, generator.describeOptions(this.data.options));
      this.refreshHistory();
    }
  },

  onRegenerate() {
    this.generate(true);
  },

  onLengthPickerChange(event) {
    const index = Number(event.detail.value);
    const length = this.data.lengthOptions[index];
    if (!length) return;
    this.setData({ lengthIndex: index, 'options.length': length }, () => this.generate(true));
  },

  onLength(event) {
    // 保留该事件作为旧数据或自动化测试的兼容入口；页面已改为点击圆形数字选择长度。
    const length = event.detail.value;
    const isFinal = event.type === 'change';
    this.setData({ 'options.length': length }, () => {
      if (isFinal) this.generate(true);
      else this.previewOnly();
    });
  },

  previewOnly() {
    const password = generator.generate(this.data.options);
    if (password) this.setData({ password, strength: generator.strengthLevel(password) });
  },

  onToggle(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({ [`options.${key}`]: event.detail.value }, () => this.generate(false));
  },

  /** "排除小写 l 和 o" 一个开关管两个选项 */
  onToggleBoth(event) {
    const value = event.detail.value;
    this.setData({ 'options.excludeLowerL': value, 'options.excludeLowerO': value }, () => this.generate(false));
  },

  onCopy() {
    if (!this.data.password) return;
    wx.setClipboardData({
      data: this.data.password,
      success: () => wx.showToast({ title: '已复制 · 请尽快粘贴', icon: 'none', duration: 2000 }),
    });
  },

  /** 从编辑页跳来的"生成器…",选完回填 */
  onUse() {
    if (!this.data.password) return;
    const channel = this.getOpenerEventChannel && this.getOpenerEventChannel();
    if (channel && channel.emit) channel.emit('picked', this.data.password);
    wx.navigateBack();
  },

  onCopyHistory(event) {
    const item = store.listGenerations().find((row) => row.id === event.currentTarget.dataset.id);
    if (!item) return;
    wx.setClipboardData({
      data: item.password,
      success: () => wx.showToast({ title: '已复制', icon: 'none' }),
    });
  },

  onHistoryLongPress(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({
      title: '删除生成历史',
      content: '确认删除这条生成记录吗？删除后无法恢复。',
      confirmText: '删除',
      confirmColor: '#D93025',
      success: async (res) => {
        if (!res.confirm) return;
        await store.deleteGenerations([id]);
        this.refreshHistory();
      },
    });
  },

  onClearHistory() {
    wx.showModal({
      title: '清空生成历史',
      content: '已保存到静态密码账本的记录不受影响。',
      confirmText: '清空',
      confirmColor: '#D93025',
      success: async (res) => {
        if (!res.confirm) return;
        await store.deleteGenerations(store.listGenerations().map((item) => item.id));
        this.refreshHistory();
      },
    });
  },

});
