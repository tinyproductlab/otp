const store = require('../../utils/store.js');
const totp = require('../../utils/totp.js');
const tokenView = require('../../utils/token-view.js');

Page({
  data: {
    isEdit: false,
    form: { issuer: '', accountName: '', secret: '', digits: 6, period: 30, algorithm: 'SHA1' },
    previewCode: '— — —',
    previewHint: '填入密钥后这里会显示验证码',
    previewOk: false,
    canSave: false,
  },

  onLoad(query) {
    getApp().ready().then(() => {
      if (!query.id) return;
      const token = store.getOtpToken(query.id);
      if (!token) {
        wx.showToast({ title: '记录不存在', icon: 'none' });
        return;
      }
      this.setData(
        {
          isEdit: true,
          editingId: token.id,
          form: {
            issuer: token.issuer || '',
            accountName: token.accountName || '',
            secret: token.secret || '',
            digits: token.digits || 6,
            period: token.period || 30,
            algorithm: token.algorithm || 'SHA1',
          },
        },
        () => this.updatePreview()
      );
      wx.setNavigationBarTitle({ title: '编辑验证码' });
    });
  },

  onShow() {
    this.timer = setInterval(() => this.updatePreview(), 1000);
  },

  onHide() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  },

  onUnload() {
    if (this.timer) clearInterval(this.timer);
  },

  onInput(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({ [`form.${key}`]: event.detail.value }, () => this.updateSavable());
  },

  onSecretInput(event) {
    this.setData({ 'form.secret': event.detail.value }, () => this.updatePreview());
  },

  onDigits(event) {
    this.setData({ 'form.digits': Number(event.currentTarget.dataset.value) }, () => this.updatePreview());
  },

  onPeriod(event) {
    this.setData({ 'form.period': Number(event.currentTarget.dataset.value) }, () => this.updatePreview());
  },

  onAlgorithm(event) {
    this.setData({ 'form.algorithm': event.currentTarget.dataset.value }, () => this.updatePreview());
  },

  /** 实时算一遍验证码。密钥不合法就明确告诉用户,而不是显示一个假的。 */
  updatePreview() {
    const form = this.data.form;
    if (!form.secret || !form.secret.trim()) {
      this.setData({
        previewCode: '— — —',
        previewHint: '填入密钥后这里会显示验证码',
        previewOk: false,
      });
      this.updateSavable();
      return;
    }
    try {
      const code = totp.code(form, Date.now());
      const remaining = totp.remainingSeconds(form, Date.now());
      // 用共用的格式化,别各写各的 —— 原来这里 7 位显示成 "751 7214"(3+4),
      // 列表页是 "7517 214"(4+3),同一个验证码两个页面长得不一样。
      const display = tokenView.formatCode(code);
      this.setData({
        previewCode: display,
        previewHint: `${remaining} 秒后刷新 · 和网站上显示的一致就说明填对了`,
        previewOk: true,
      });
    } catch (error) {
      this.setData({
        previewCode: '密钥无效',
        previewHint: error.message || '这不是合法的 Base32 密钥',
        previewOk: false,
      });
    }
    this.updateSavable();
  },

  updateSavable() {
    const form = this.data.form;
    const hasName = !!(form.issuer.trim() || form.accountName.trim());
    this.setData({ canSave: hasName && totp.isValidSecret(form.secret) });
  },

  async onSave() {
    if (!this.data.canSave) {
      const form = this.data.form;
      if (!totp.isValidSecret(form.secret)) {
        wx.showToast({ title: '密钥不合法', icon: 'none' });
      } else {
        wx.showToast({ title: '请填写发行商或账号', icon: 'none' });
      }
      return;
    }

    const payload = Object.assign({}, this.data.form, {
      secret: totp.normalizeSecret(this.data.form.secret),
    });
    if (this.data.editingId) payload.id = this.data.editingId;

    try {
      await store.saveOtpToken(payload);
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (error) {
      if (error.code === 'DUPLICATE') {
        wx.showModal({
          title: '重复的验证码',
          content: '这个密钥、发行商、账号的组合已经添加过了。',
          showCancel: false,
        });
        return;
      }
      wx.showToast({ title: error.message || '保存失败', icon: 'none' });
    }
  },

});
