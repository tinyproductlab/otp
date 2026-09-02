const store = require('../../utils/store.js');

const KIND_LABELS = { password: '密码', otp: '验证码' };
const RETENTION_LABELS = { 7: '7 天', 30: '30 天', 90: '90 天', 0: '永久' };

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

Page({
  data: {
    items: [],
    selected: {},
    selectedCount: 0,
    allSelected: false,
    retentionLabel: '30 天',
  },

  onLoad() {
    getApp().ready().then(() => this.refresh());
  },

  onShow() {
    if (getApp().globalData.ready) this.refresh();
  },

  refresh() {
    const settings = store.getSettings();
    const days = settings.trashRetentionDays;
    const items = store.listTrash().map((item) => {
      let expiryText = '永久保留';
      if (days) {
        const remaining = Math.ceil((item.deletedAt + days * 86400000 - Date.now()) / 86400000);
        expiryText = remaining <= 0 ? '即将清除' : `${remaining} 天后清除`;
      }
      return Object.assign({}, item, {
        kindLabel: KIND_LABELS[item.kind] || '记录',
        timeText: formatTime(item.deletedAt),
        expiryText,
        selected: !!this.data.selected[item.id],
      });
    });

    const selectedCount = items.filter((item) => item.selected).length;
    this.setData({
      items,
      selectedCount,
      allSelected: items.length > 0 && selectedCount === items.length,
      retentionLabel: RETENTION_LABELS[days] || '30 天',
    });
  },

  onToggle(event) {
    const id = event.currentTarget.dataset.id;
    const selected = Object.assign({}, this.data.selected);
    if (selected[id]) delete selected[id];
    else selected[id] = true;
    this.setData({ selected }, () => this.refresh());
  },

  onToggleAll() {
    if (this.data.allSelected) {
      this.setData({ selected: {} }, () => this.refresh());
      return;
    }
    const selected = {};
    this.data.items.forEach((item) => { selected[item.id] = true; });
    this.setData({ selected }, () => this.refresh());
  },

  selectedIds() {
    return Object.keys(this.data.selected);
  },

  async onRestoreSelected() {
    const ids = this.selectedIds();
    if (!ids.length) return;
    for (const id of ids) await store.restoreTrash(id);
    this.setData({ selected: {} }, () => this.refresh());
    wx.showToast({ title: `已恢复 ${ids.length} 项`, icon: 'success' });
  },

  onDeleteSelected() {
    const ids = this.selectedIds();
    if (!ids.length) return;
    wx.showModal({
      title: '彻底删除',
      content: `${ids.length} 项将被永久删除,无法恢复。`,
      confirmText: '删除',
      confirmColor: '#D93025',
      success: async (res) => {
        if (!res.confirm) return;
        await store.deleteTrashForever(ids);
        this.setData({ selected: {} }, () => this.refresh());
        wx.showToast({ title: '已删除', icon: 'success' });
      },
    });
  },

  onRestoreAll() {
    const ids = this.data.items.map((item) => item.id);
    if (!ids.length) return;
    wx.showModal({
      title: '全部恢复',
      content: `${ids.length} 项将恢复到原来的位置。`,
      success: async (res) => {
        if (!res.confirm) return;
        for (const id of ids) await store.restoreTrash(id);
        this.setData({ selected: {} }, () => this.refresh());
        wx.showToast({ title: '已全部恢复', icon: 'success' });
      },
    });
  },

  onEmpty() {
    wx.showModal({
      title: '清空回收站',
      content: `${this.data.items.length} 项将被永久删除,无法恢复。`,
      confirmText: '清空',
      confirmColor: '#D93025',
      success: async (res) => {
        if (!res.confirm) return;
        await store.emptyTrash();
        this.setData({ selected: {} }, () => this.refresh());
        wx.showToast({ title: '已清空', icon: 'success' });
      },
    });
  },

});
