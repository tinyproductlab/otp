const qrcode = require('../../utils/qrcode-generator.js');
const store = require("../../utils/store.js");

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

Page({
  data: {
    content: '',
    qrPayload: '',
    displayContent: '',
    remark: '',
    qrGrid: [],
    qrImage: '',
    history: [],
    historyExpanded: false,
  },

  onLoad() {
    getApp().ready().then(() => this.refreshHistory());
  },

  onReady() {
    this.canvasReady = true;
    if (this.data.qrPayload) this.drawQr(this.data.qrPayload, this.data.remark);
  },

  refreshHistory() {
    this.setData({
      history: store.listQrHistory().map((item) => Object.assign({}, item, {
        timeText: formatTime(item.createdAt),
      })),
    });
  },

  onInput(event) {
    this.setData({ content: event.detail.value, qrPayload: '', remark: '', displayContent: '' });
  },

  onToggleHistory() {
    this.setData({ historyExpanded: !this.data.historyExpanded });
  },
  onClear() {
    // qrGrid 也要清:界面靠 qrPayload 控制显隐,所以不清也看不见,
    // 但那是几百个格子的数组,留在渲染层数据里白占着。
    this.setData({ content: '', qrPayload: '', remark: '', displayContent: '', qrGrid: [] });
  },

  async onGenerate() {
    const content = String(this.data.content || '').trim();
    if (!content) {
      wx.showToast({ title: '请输入文字或链接', icon: 'none' });
      return;
    }
    try {
      this.setData({ qrPayload: content, remark: '', displayContent: content }, () => wx.nextTick(() => this.drawQr(content)));
      await store.addQrHistory(content, 'generated');
      this.refreshHistory();
      wx.showToast({ title: '二维码已生成', icon: 'success' });
    } catch (error) {
      wx.showModal({ title: '生成失败', content: error.message || '内容过长或格式不支持', showCancel: false });
    }
  },

  drawQr(content, remark = '') {
    // 先生成并写入可见矩阵；它不能依赖 canvasReady。
    // 二维码库默认按低 8 位编码中文，会导致扫码乱码；明确切换到 UTF-8 字节模式。
    qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
    const qr = qrcode(0, 'M');
    qr.addData(content, 'Byte');
    qr.make();
    const count = qr.getModuleCount();
    const qrGrid = [];
    for (let row = 0; row < count; row++) {
      const line = [];
      for (let col = 0; col < count; col++) line.push(qr.isDark(row, col));
      qrGrid.push(line);
    }
    const qrImage = qr.createDataURL(8, 32);
    this.setData({ qrGrid, qrImage });
    if (!this.canvasReady) return;

    const size = 240;
    const canvasHeight = 280;
    const margin = 16;
    const cell = (size - margin * 2) / count;
    const ctx = wx.createCanvasContext('qrCanvas', this);
    ctx.setFillStyle('#FFFFFF');
    ctx.fillRect(0, 0, size, canvasHeight);
    ctx.setFillStyle('#111827');
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(margin + col * cell, margin + row * cell, cell + 0.4, cell + 0.4);
        }
      }
    }
    if (remark) {
      ctx.setFillStyle('#111827');
      ctx.setFontSize(14);
      ctx.setTextAlign('center');
      ctx.fillText(remark, size / 2, 265, 208);
    }
    ctx.draw();
  },

  onUseHistory(event) {
    const item = this.data.history.find((row) => row.id === event.currentTarget.dataset.id);
    if (!item) return;
    this.setData({ content: item.content, qrPayload: item.content, displayContent: item.content }, () => this.drawQr(item.content));
  },

  onDownload() {
    if (!this.data.content) return;
    wx.showModal({
      title: '填写二维码备注',
      editable: true,
      placeholderText: '例如：家庭 Wi-Fi、会议签到、收款信息',
      confirmText: '下载',
      success: (res) => {
        if (!res.confirm) return;
        const remark = String(res.content || '').trim();
        if (!remark) {
          wx.showToast({ title: '请填写备注', icon: 'none' });
          return;
        }
        const content = this.data.content;
        this.setData({ qrPayload: content, remark, displayContent: `${remark}：${content}` }, () => wx.nextTick(() => {
          this.drawQr(content, remark);
          wx.canvasToTempFilePath({
            canvasId: 'qrCanvas', width: 240, height: 280, destWidth: 960, destHeight: 1120,
            success: (file) => wx.saveImageToPhotosAlbum({
              filePath: file.tempFilePath,
              success: async () => {
                wx.showToast({ title: '已保存到相册', icon: 'success' });
              },
              fail: () => wx.showModal({ title: '无法保存图片', content: '请在系统设置中允许微信访问照片后重试。', showCancel: false }),
            }),
            fail: () => wx.showToast({ title: '二维码导出失败', icon: 'none' }),
          }, this);
        }));
      },
    });
  },

  onDeleteHistory(event) {
    const id = event.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: ['删除这条记录', '全部删除'],
      success: (res) => {
        if (res.tapIndex === 0) {
          wx.showModal({ title: '删除记录', content: '确定删除这条二维码记录吗？', confirmText: '删除', confirmColor: '#D93025', success: async (confirm) => {
            if (!confirm.confirm) return;
            await store.deleteQrHistory(id);
            this.refreshHistory();
            wx.showToast({ title: '已删除', icon: 'success' });
          } });
        } else if (res.tapIndex === 1) {
          wx.showModal({ title: '全部删除', content: '确定删除全部二维码生成记录吗？删除后不可恢复。', confirmText: '全部删除', confirmColor: '#D93025', success: async (confirm) => {
            if (!confirm.confirm) return;
            await store.clearQrHistory();
            this.refreshHistory();
            wx.showToast({ title: '已全部删除', icon: 'success' });
          } });
        }
      },
      fail: () => {},
    });
  },

});
