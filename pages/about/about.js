const store = require('../../utils/store.js');
const i18n = require('../../utils/i18n.js');

Page({
  data: {
    version: '1.1.0',
    copy: i18n.about('zh-Hans'),
  },
  onLoad() {
    const app = getApp();
    if (app.applyTheme) app.applyTheme();
    this.setData({ copy: i18n.about(store.getSettings().locale) });
  },
  onShow() {
    this.setData({ copy: i18n.about(store.getSettings().locale) });
  },
  onCopyOfficialAccount() {
    const copy = this.data.copy || i18n.about(store.getSettings().locale);
    wx.setClipboardData({
      data: '小产品实验室',
      success: () => wx.showToast({ title: copy.copiedOfficial, icon: 'success' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' }),
    });
  },
});
