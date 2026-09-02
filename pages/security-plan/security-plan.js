'use strict';

const store = require('../../utils/store.js');
const securityPlan = require('../../utils/security-plan.js');

Page({
  data: {
    snapshot: null,
    plan: { source: 'local', total: 0, completed: 0, tasks: [] },
    privacyVisible: false,
    progressText: '正在读取本地安全状态',
  },

  onLoad() {
    getApp().ready().then(() => this.refresh());
    this.unsubscribe = store.subscribe(() => this.refresh());
  },

  onShow() {
    if (getApp().globalData.ready) this.refresh();
  },

  onUnload() {
    if (this.unsubscribe) this.unsubscribe();
  },

  refresh() {
    const snapshot = securityPlan.createSnapshot(store.stats(), store.getWebdav());
    const plan = securityPlan.buildPlan(snapshot);
    const completed = plan.completed || 0;
    const progressText = completed
      ? '当前没有需要优先处理的风险'
      : `建议先完成第 1 项，再逐步处理剩余 ${Math.max(0, plan.total - 1)} 项`;
    this.setData({ snapshot, plan, progressText });
  },

  onTogglePrivacy() {
    this.setData({ privacyVisible: !this.data.privacyVisible });
  },

  onTaskTap(event) {
    const action = event.currentTarget.dataset.action;
    const routes = {
      'backup-local': '/pages/backup/backup?mode=wechat&from=security-plan',
      'backup-home': '/pages/backup/backup?mode=home&from=security-plan',
      'password-duplicate': '/pages/password/password?risk=duplicate&from=security-plan',
      'password-weak': '/pages/password/password?risk=weak&from=security-plan',
      'add-otp': '/pages/otp-edit/otp-edit?from=security-plan',
    };
    const url = routes[action];
    if (url) {
      wx.navigateTo({ url });
      return;
    }
    wx.showToast({ title: '这个建议暂时不可用', icon: 'none' });
  },
});
