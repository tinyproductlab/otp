const store = require('../../utils/store.js');
const bundleTransfer = require('../../utils/otp-bundle-transfer.js');
const otpTransfer = require('../../utils/otp-transfer.js');
const qrcode = require('../../utils/qrcode-generator.js');

const EXPIRY_OPTIONS = [
  { value: 5, label: '5 分钟' },
  { value: 15, label: '15 分钟' },
  { value: 60, label: '1 小时' },
  { value: 1440, label: '24 小时' },
  { value: 0, label: '不设有效期' },
];

function formatTime(seconds) {
  if (!seconds) return '不设有效期';
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

function decodePayload(value) {
  try { return decodeURIComponent(value || ''); } catch (error) { return value || ''; }
}

Page({
  data: {
    mode: 'create',
    stage: 'form',
    tokenCount: 0,
    skippedCount: 0,
    skippedText: '',
    transferPassword: '',
    passwordVisible: false,
    expiryOptions: EXPIRY_OPTIONS,
    expiryMinutes: 15,
    qrGrid: [],
    qrIndex: 0,
    qrTotal: 0,
    qrPageText: '',
    expiresAt: 0,
    remainingText: '',
    passwordProtected: false,
    collectedCount: 0,
    importTotal: 0,
    collectionPercent: 0,
    importMeta: null,
    importPassword: '',
    importPasswordVisible: false,
    busy: false,
    busyTitle: '',
    busyPercent: 0,
    successTitle: '',
    successText: '',
  },

  onLoad(options) {
    this.canvasReady = false;
    this.bundlePayloads = [];
    this.collected = null;
    getApp().ready().then(() => {
      if (options && options.mode === 'import') {
        this.openImport(decodePayload(options.payload));
        return;
      }
      this.openCreate();
    });
  },

  onReady() {
    this.canvasReady = true;
    if (this.bundlePayloads.length) this.drawQr(this.bundlePayloads[this.data.qrIndex]);
  },

  onShow() {
    if (this.data.stage === 'qr') this.startCountdown();
  },

  onHide() { this.stopCountdown(); },
  onUnload() { this.stopCountdown(); },

  openCreate() {
    const all = store.listOtpTokens();
    if (!all.length) {
      wx.showToast({ title: '暂无可导出的 OTP', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 300);
      return;
    }
    // 页头要报**能导出的**条数。原来报总数,有坏条目时会出现
    // "共 4 条"却只导出 3 条,对不上。
    const { valid, invalid } = otpTransfer.partitionTokens(all);
    this.setData({
      mode: 'create',
      stage: 'form',
      tokenCount: valid.length,
      skippedCount: invalid.length,
      skippedText: invalid.length ? `另有 ${invalid.length} 条密钥或参数异常，无法迁移` : '',
    });
    wx.setNavigationBarTitle({ title: '导出全部 OTP' });
  },

  openImport(payload) {
    this.setData({ mode: 'import', stage: 'collect' });
    wx.setNavigationBarTitle({ title: '导入全部 OTP' });
    this.collectPayload(payload, true);
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

  toggleImportPasswordVisible() {
    this.setData({ importPasswordVisible: !this.data.importPasswordVisible });
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
        success: (result) => { if (result.confirm) this.generateBundle(); },
      });
      return;
    }
    return this.generateBundle();
  },

  /**
   * 把坏条目挑出来问用户,而不是让一条坏的把整批导出废掉。
   * @returns {Promise<object[]|null>} 要导出的令牌;用户取消时返回 null
   */
  pickExportableTokens() {
    const { valid, invalid } = otpTransfer.partitionTokens(store.listOtpTokens());
    if (!invalid.length) return Promise.resolve(valid);

    const lines = invalid.slice(0, 5).map((x) => `· ${x.reason}`).join('\n');
    const more = invalid.length > 5 ? `\n…另有 ${invalid.length - 5} 条` : '';

    if (!valid.length) {
      wx.showModal({
        title: '没有可导出的验证码',
        content: `全部 ${invalid.length} 条都无法迁移：\n${lines}${more}`,
        showCancel: false,
      });
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      wx.showModal({
        title: `${invalid.length} 条无法迁移`,
        content: `以下条目会被跳过：\n${lines}${more}\n\n其余 ${valid.length} 条可以正常导出。`,
        // confirmText / cancelText 最多 4 个字,超了 showModal 会直接 fail、
        // 弹不出来 —— 数量放进 content,按钮只留动作
        confirmText: '继续导出',
        cancelText: '取消',
        success: (res) => resolve(res.confirm ? valid : null),
        // 弹窗本身失败(参数不合法等)不能静默吞掉,否则表现为"点了没反应"
        fail: (error) => {
          wx.showToast({ title: '无法显示提示：' + ((error && error.errMsg) || '未知错误'), icon: 'none' });
          resolve(null);
        },
      });
    });
  },

  async generateBundle() {
    const exportable = await this.pickExportableTokens();
    if (!exportable) return;
    this.setData({ busy: true, busyTitle: '正在加密全部 OTP', busyPercent: 0 });
    try {
      const result = await bundleTransfer.encrypt(exportable, this.data.transferPassword, {
        expiryMinutes: this.data.expiryMinutes,
        onProgress: (ratio) => this.setData({ busyPercent: Math.min(99, Math.round(ratio * 100)) }),
      });
      this.bundlePayloads = result.payloads;
      this.setData({
        stage: 'qr',
        qrIndex: 0,
        qrTotal: result.total,
        qrPageText: `第 1 / ${result.total} 张`,
        expiresAt: result.expiresAt,
        remainingText: result.permanent ? '不设有效期' : formatRemaining(Math.max(0, result.expiresAt - Math.floor(Date.now() / 1000))),
        passwordProtected: result.passwordProtected,
        busyPercent: 100,
      }, () => this.drawQr(result.payloads[0]));
      this.startCountdown();
    } catch (error) {
      wx.showModal({ title: '生成失败', content: error.message || '无法生成迁移二维码', showCancel: false });
    } finally {
      this.setData({ busy: false });
    }
  },

  onPreviousQr() {
    this.showQrAt(this.data.qrIndex - 1);
  },

  onNextQr() {
    this.showQrAt(this.data.qrIndex + 1);
  },

  showQrAt(index) {
    if (index < 0 || index >= this.bundlePayloads.length) return;
    this.setData({ qrIndex: index, qrPageText: `第 ${index + 1} / ${this.bundlePayloads.length} 张` }, () => this.drawQr(this.bundlePayloads[index]));
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
      const ctx = wx.createCanvasContext('bundleTransferQrCanvas', this);
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

  onScanNext() {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode'],
      success: (result) => this.collectPayload(result.result || '', false),
      fail: (error) => {
        if (error && /cancel/i.test(error.errMsg || '')) return;
        wx.showToast({ title: '扫码未完成', icon: 'none' });
      },
    });
  },

  onResetCollection() {
    this.collected = null;
    this.setData({ collectedCount: 0, importTotal: 0, collectionPercent: 0, importMeta: null, stage: 'collect' });
  },

  collectPayload(payload, isInitial) {
    let part;
    try {
      part = bundleTransfer.parsePart(payload);
    } catch (error) {
      wx.showModal({ title: '无法识别', content: error.message || '这不是完整 OTP 迁移二维码', showCancel: false });
      return;
    }
    if (!this.collected) {
      this.collected = { sessionId: part.sessionId, total: part.total, parts: {} };
    }
    if (this.collected.sessionId !== part.sessionId || this.collected.total !== part.total) {
      wx.showModal({ title: '二维码不属于同一组', content: '请继续扫描同一组二维码，或点“重新开始”后扫描另一组。', showCancel: false });
      return;
    }
    const exists = !!this.collected.parts[part.part];
    this.collected.parts[part.part] = part.payload;
    const collectedCount = Object.keys(this.collected.parts).length;
    this.setData({
      collectedCount,
      importTotal: this.collected.total,
      collectionPercent: Math.round((collectedCount * 100) / this.collected.total),
    });
    if (exists && !isInitial) {
      wx.showToast({ title: `第 ${part.part} 张已扫描`, icon: 'none' });
      return;
    }
    if (collectedCount < this.collected.total) {
      if (!isInitial) wx.showToast({ title: `已收集 ${collectedCount}/${this.collected.total}`, icon: 'success' });
      return;
    }
    try {
      const meta = bundleTransfer.inspect(this.collected.parts);
      this.setData({
        stage: meta.expired ? 'expired' : 'import',
        importMeta: Object.assign({}, meta, { expiryText: meta.permanent ? '不设有效期' : formatTime(meta.expiresAt) }),
      });
    } catch (error) {
      wx.showModal({ title: '无法读取', content: error.message || '迁移二维码内容异常', showCancel: false });
    }
  },

  async onDecryptImport() {
    const password = this.data.importPassword;
    if (password && password.length < 6) {
      wx.showToast({ title: '访问密码至少 6 位', icon: 'none' });
      return;
    }
    this.setData({ busy: true, busyTitle: '正在解密并导入', busyPercent: 0 });
    try {
      const result = await bundleTransfer.decrypt(this.collected.parts, password, {
        onProgress: (ratio) => this.setData({ busyPercent: Math.min(99, Math.round(ratio * 100)) }),
      });
      const counts = await store.importOtpTokens(result.tokens);
      this.setData({
        stage: 'success',
        successTitle: '全部 OTP 已合并',
        successText: `已添加 ${counts.added} 条${counts.duplicate ? `，重复 ${counts.duplicate} 条未重复创建` : ''}。`,
        busyPercent: 100,
      });
    } catch (error) {
      if (error.code === 'BUNDLE_EXPIRED') {
        this.setData({ stage: 'expired' });
      } else {
        wx.showModal({ title: '无法导入', content: error.message || '导入失败', showCancel: false });
      }
    } finally {
      this.setData({ busy: false });
    }
  },

  onViewTokens() { wx.navigateBack({ delta: 1 }); },
  onClose() { wx.navigateBack({ delta: 1 }); },
});
