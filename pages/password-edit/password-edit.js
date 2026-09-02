const store = require('../../utils/store.js');
const generator = require('../../utils/generator.js');

function formatTime(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

Page({
  data: {
    isEdit: false,
    revealed: false,
    form: { title: '', site: '', username: '', password: '', notes: '', group: '' },
    groups: [],
    groupNames: [],
    groupIndex: 0,
    strength: { level: 'weak', label: '较弱', score: 0 },
    canSave: false,
    createdAtText: '',
    updatedAtText: '',
  },

  onLoad(query) {
    getApp().ready().then(() => {
      const groups = store.listGroups();
      const groupNames = groups.map((g) => g.displayName);

      if (query.id) {
        const item = store.getPassword(query.id);
        if (!item) {
          wx.showToast({ title: '记录不存在', icon: 'none' });
          return;
        }
        const groupIndex = Math.max(0, groups.findIndex((g) => g.id === item.group));
        this.setData({
          isEdit: true,
          editingId: item.id,
          groups,
          groupNames,
          groupIndex,
          form: {
            title: item.title || '',
            site: item.site || '',
            username: item.username || '',
            password: item.password || '',
            notes: item.notes || '',
            group: item.group,
          },
          createdAtText: formatTime(item.createdAt),
          updatedAtText: formatTime(item.updatedAt),
        }, () => this.recompute());
        wx.setNavigationBarTitle({ title: '编辑凭证' });
      } else {
        const groupIndex = query.group
          ? Math.max(0, groups.findIndex((g) => g.id === query.group))
          : 0;
        this.setData({ groups, groupNames, groupIndex, 'form.group': groups[groupIndex].id }, () => this.recompute());
        wx.setNavigationBarTitle({ title: '新增凭证' });
      }
    });
  },

  onInput(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({ [`form.${key}`]: event.detail.value }, () => this.recompute());
  },

  onPasswordInput(event) {
    this.setData({ 'form.password': event.detail.value }, () => this.recompute());
  },

  onToggleReveal() {
    this.setData({ revealed: !this.data.revealed });
  },

  onGroupChange(event) {
    const index = Number(event.detail.value);
    this.setData({ groupIndex: index, 'form.group': this.data.groups[index].id });
  },

  recompute() {
    const form = this.data.form;
    this.setData({
      strength: generator.strengthLevel(form.password),
      // 标题或网站至少要有一个,否则列表里就是一条无从辨认的记录
      canSave: !!(form.title.trim() || form.site.trim()),
    });
  },

  /** 去生成器细调。带上回填标记,生成器那边保存后会写回这里。 */
  onOpenGenerator() {
    wx.navigateTo({
      url: '/pages/generator/generator?pick=1',
      events: {
        picked: (password) => {
          this.setData({ 'form.password': password, revealed: true }, () => this.recompute());
        },
      },
    });
  },

  async onSave() {
    if (!this.data.canSave) {
      wx.showToast({ title: '请至少填写标题或网站', icon: 'none' });
      return;
    }
    const payload = Object.assign({}, this.data.form);
    if (this.data.editingId) payload.id = this.data.editingId;

    try {
      await store.savePassword(payload);
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (error) {
      wx.showToast({ title: error.message || '保存失败', icon: 'none' });
    }
  },

});
