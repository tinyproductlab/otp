const store = require('../../utils/store.js');
const transfer = require('../../utils/otp-transfer.js');
const qrcode = require('../../utils/qrcode-generator.js');

const EXPIRY_OPTIONS = [
  { value: 5, label: '5 分钟' },
  { value: 15, label: '15 分钟' },
  { value: 60, label: '1 小时' },
  { value: 1440, label: '24 小时' },
  { value: 0, label: '永不过期' },
];

function formatTime(seconds) {
  if (!seconds) return '永不过期';
  const date = new Date(seconds * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatRemaining(seconds) {
  if (seconds <= 0) return '已过期';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `还可使用 ${minutes} 分 ${String(rest).padStart(2, '0')} 秒` : `还可使用 ${rest} 秒`;
}

Page({
  data: {
    mode: 'create',
    stage: 'form',
    token: null,
    transferPassword: '',
    passwordVisible: false,
    expiryOptions: EXPIRY_OPTIONS,
    expiryMinutes: 15,
    qrGrid: [],
    qrPayload: '',
    expiresAt: 0,
    remainingText: '',
    payload: '',
    importMeta: null,
    importPassword: '',
    busy: false,
    busyTitle: '',
    busyPercent: 0,
    successTitle: '',
  },

  onLoad(options) {
    this.canvasReady = false;
    getApp().ready().then(() => {
      if (options && options.mode === 'import') {
        let payload = options.payload || '';
        try { payload = decodeURIComponent(payload); } catch (error) { /* 保留原始扫码内容，交由协议层校验 */ }
        this.openImport(payload);
        return;
      }
      this.openCreate(options && options.id);
    });
  },

  onReady() {
    this.canvasReady = true;
    if (this.data.qrPayload) this.drawQr(this.data.qrPayload);
  },

  onShow() {
    if (this.data.stage === 'qr') this.startCountdown();
  },

  onHide() { this.stopCountdown(); },
  onUnload() { this.stopCountdown(); },

  openCreate(id) {
    const token = store.getOtpToken(id);
    if (!token) {
      wx.showToast({ title: '验证码不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 300);
      return;
    }
    this.setData({
      mode: 'create',
      stage: 'form',
      token: {
        id: token.id,
        issuer: token.issuer || '未命名',
        accountName: token.accountName || '—',
        secret: token.secret,
        digits: token.digits || 6,
        period: token.period || 30,
        algorithm: token.algorithm || 'SHA1',
      },
    });
    wx.setNavigationBarTitle({ title: '生成迁移二维码' });
  },

  openImport(payload) {
    let meta;
    try {
      meta = transfer.inspect(payload);
    } catch (error) {
      wx.showModal({ title: '无法识别', content: error.message || '这不是加密迁移二维码', showCancel: false, success: () => wx.navigateBack() });
      return;
    }
    this.setData({
      mode: 'import',
      stage: meta.expired ? 'expired' : 'import',
      payload,
      importMeta: Object.assign({}, meta, { expiryText: meta.permanent ? '永不过期' : formatTime(meta.expiresAt) }),
    });
    wx.setNavigationBarTitle({ title: '导入迁移验证码' });
  },

  onInput(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({ [key]: event.detail.value });
  },

  onSelectExpiry(event) {
    this.setData({ expiryMinutes: Number(event.currentTarget.dataset.value) });
  },

  togglePasswordVisible() {
    this.setData({ passwordVisible: !this.data.passwordVisible });
  },

  async onGenerate() {
    const password = this.data.transferPassword;
    if (password && password.length < 6) {
      wx.showToast({ title: '访问密码至少 6 位', icon: 'none' });
      return;
    }
    if (!password && this.data.expiryMinutes === 0) {
      wx.showToast({ title: '请设置访问密码或有效期', icon: 'none' });
      return;
    }
    if (!password) {
      wx.showModal({
        title: '仅使用有效期保护',
        content: '二维码在有效期内无需密码即可导入。请勿截图公开传播；有效期依赖接收设备本地时间检查。',
        confirmText: '继续生成',
        success: (result) => { if (result.confirm) this.generateTransfer(); },
      });
      return;
    }
    return this.generateTransfer();
  },

  async generateTransfer() {
    this.setData({ busy: true, busyTitle: '正在加密迁移二维码', busyPercent: 0 });
    try {
      const result = await transfer.encrypt(this.data.token, this.data.transferPassword, {
        expiryMinutes: this.data.expiryMinutes,
        onProgress: (ratio) => this.setData({ busyPercent: Math.min(99, Math.round(ratio * 100)) }),
      });
      this.setData({
        stage: 'qr',
        qrPayload: result.payload,
        expiresAt: result.expiresAt,
        busyPercent: 100,
        remainingText: result.permanent ? '永不过期' : formatRemaining(Math.max(0, result.expiresAt - Math.floor(Date.now() / 1000))),
      }, () => this.drawQr(result.payload));
      this.startCountdown();
    } catch (error) {
      wx.showModal({ title: '生成失败', content: error.message || '无法生成迁移二维码', showCancel: false });
    } finally {
      this.setData({ busy: false });
    }
  },

  drawQr(payload) {
    try {
      qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
      const qr = qrcode(0, 'M');
      qr.addData(payload, 'Byte');
      qr.make();
      const count = qr.getModuleCount();
      const qrGrid = [];
      for (let row = 0; row < count; row += 1) {
        const line = [];
        for (let col = 0; col < count; col += 1) line.push(qr.isDark(row, col));
        qrGrid.push(line);
      }
      this.setData({ qrGrid });
      if (!this.canvasReady) return;
      const size = 280;
      const margin = 18;
      const cell = (size - margin * 2) / count;
      const ctx = wx.createCanvasContext('transferQrCanvas', this);
      ctx.setFillStyle('#FFFFFF');
      ctx.fillRect(0, 0, size, size);
      ctx.setFillStyle('#172C45');
      for (let row = 0; row < count; row += 1) {
        for (let col = 0; col < count; col += 1) {
          if (qr.isDark(row, col)) ctx.fillRect(margin + col * cell, margin + row * cell, cell + 0.35, cell + 0.35);
        }
      }
      ctx.draw();
    } catch (error) {
      wx.showModal({ title: '二维码生成失败', content: error.message || '内容过长，请改用微信导入导出', showCancel: false });
    }
  },

  startCountdown() {
    this.stopCountdown();
    if (!this.data.expiresAt) return;
    const update = () => {
      const remaining = this.data.expiresAt - Math.floor(Date.now() / 1000);
      if (remaining <= 0) {
        this.stopCountdown();
        this.setData({ stage: 'expired', remainingText: '已过期' });
        return;
      }
      this.setData({ remainingText: formatRemaining(remaining) });
    };
    update();
    this.timer = setInterval(update, 1000);
  },

  stopCountdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  },

  async onDecryptImport() {
    const password = this.data.importPassword;
    if (password && password.length < 6) {
      wx.showToast({ title: '访问密码至少 6 位', icon: 'none' });
      return;
    }
    this.setData({ busy: true, busyTitle: '正在解密并导入', busyPercent: 0 });
    try {
      const token = await transfer.decrypt(this.data.payload, password, {
        onProgress: (ratio) => this.setData({ busyPercent: Math.min(99, Math.round(ratio * 100)) }),
      });
      await store.saveOtpToken(token);
      this.setData({
        stage: 'success',
        successTitle: `${token.issuer || token.accountName || '验证码'} 已导入`,
        busyPercent: 100,
      });
    } catch (error) {
      if (error.code === 'DUPLICATE') {
        wx.showModal({ title: '验证码已存在', content: '当前设备已经保存了这条验证码，不会重复添加。', showCancel: false });
      } else if (error.code === 'TRANSFER_EXPIRED') {
        this.setData({ stage: 'expired' });
      } else {
        wx.showModal({ title: '无法导入', content: error.message || '导入失败', showCancel: false });
      }
    } finally {
      this.setData({ busy: false });
    }
  },

  onViewTokens() {
    wx.navigateBack({ delta: 1 });
  },

  onClose() {
    wx.navigateBack({ delta: 1 });
  },
});
