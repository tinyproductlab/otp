const store = require('../../utils/store.js');
const { strengthScore } = require('../../utils/generator.js');
const backup = require('../../utils/backup.js');
const dragSort = require('../../utils/drag-sort.js');
const i18n = require('../../utils/i18n.js');

// 头像底色。按标题哈希取,同一条记录颜色稳定 —— 用随机色的话每次进页面都在变。
const AVATAR_COLORS = ['#2F7CF6', '#25B96F', '#F5A623', '#B84DE5', '#27BFD5', '#F2B91F'];

Page({
  data: {
    items: [],
    groups: [],
    total: 0,
    keyword: '',
    sort: 'time',
    activeGroup: '',
    searchActive: false,
    filterVisible: false,
    riskFilter: '',
    riskFilterLabel: '',
    addMenuVisible: false,
    copiedId: '',
    dragId: '',      // 正被拖动的条目 id
    dragOffset: 0,   // 该条目跟手的 translateY(px)
    copy: i18n.otp('zh-Hans'),
  },

  /** 长按拖排。只在手动排序模式下启用。 */
  dragger() {
    if (!this._dragger) {
      this._dragger = dragSort.createDragSort({
        selector: '.entry',
        listKey: 'items',
        persist: (ids) => store.reorderPasswords(ids),
      });
    }
    return this._dragger;
  },

  onDragMove(event) {
    if (!this.dragger().isDragging()) return;
    const patch = this.dragger().move(this.data.items, event.touches && event.touches[0]);
    if (patch) this.setData(patch);
  },

  onDragEnd() {
    if (!this.dragger().isDragging()) return;
    const { patch, save } = this.dragger().end(this.data.items);
    if (patch) this.setData(patch);
    // 松手后系统还会补一个 tap,不挡住的话会顺手把密码复制到剪贴板
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

  onLoad(query = {}) {
    const riskFilter = query.risk === 'weak' || query.risk === 'duplicate' ? query.risk : '';
    const riskFilterLabel = riskFilter === 'weak' ? '仅显示较弱密码' : riskFilter === 'duplicate' ? '仅显示重复密码' : '';
    this.setData({ riskFilter, riskFilterLabel });
    getApp().ready().then(() => this.refresh());
    this.unsubscribe = store.subscribe(() => this.refresh());
  },

  onShow() {
    if (getApp().globalData.ready) this.refresh();
  },

  onHide() {
    // 拖到一半切走:丢弃这次拖动,不写库
    if (this.dragger().isDragging()) this.setData(this.dragger().cancel());
  },

  onUnload() {
    if (this.unsubscribe) this.unsubscribe();
    if (this.copyFeedbackTimer) clearTimeout(this.copyFeedbackTimer);
  },

  // 注意:这个方法目前只有 _test/verify-pages.js 在调用,模板里没有入口。
  // 不是死代码,是功能写了但界面没接上 —— 要么补按钮,要么连测试一起删。
  onSort() {
    this.setData({ sort: this.data.sort === 'time' ? 'name' : 'time' }, () => this.refresh());
  },

  refresh() {
    const copy = i18n.otp(store.getSettings().locale);
    const all = store.listPasswords({});
    // 重复密码要在全量里算,不能只看当前筛选结果
    const passwordCounts = new Map();
    all.forEach((item) => {
      if (!item.password) return;
      passwordCounts.set(item.password, (passwordCounts.get(item.password) || 0) + 1);
    });

    const items = store
      .listPasswords({ keyword: this.data.keyword, group: this.data.activeGroup, sort: this.data.sort })
      .filter((item) => {
        if (this.data.riskFilter === 'weak') return item.password && strengthScore(item.password) < 45;
        if (this.data.riskFilter === 'duplicate') return item.password && passwordCounts.get(item.password) > 1;
        return true;
      })
      .map((item) => {
        const label = (item.title || item.site || '?').trim();
        let hash = 0;
        for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) % 997;
        let risk = '';
        if (item.password && strengthScore(item.password) < 45) risk = 'weak';
        else if (item.password && passwordCounts.get(item.password) > 1) risk = 'duplicate';
        return Object.assign({}, item, {
          initial: label.charAt(0).toUpperCase(),
          avatarColor: AVATAR_COLORS[hash % AVATAR_COLORS.length],
          risk,
        });
      });

    this.setData({ items, total: all.length, groups: store.listGroups(), copy }, () => {
      // 行高要在列表渲染完之后量,拖动的换位阈值靠它
      if (this.data.sort === 'manual' && items.length > 1) this.dragger().measure(this);
    });
  },

  onSearch(event) {
    this.setData({ keyword: event.detail.value }, () => this.refresh());
  },

  onClearSearch() {
    this.setData({ keyword: '' }, () => this.refresh());
  },

  onClearRiskFilter() {
    this.setData({ riskFilter: '', riskFilterLabel: '' }, () => this.refresh());
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

  onGroup(event) {
    this.setData({ activeGroup: event.currentTarget.dataset.id }, () => this.refresh());
  },

  onCreateGroup() {
    this.onCloseAddMenu();
    wx.showModal({
      title: '新建分组',
      editable: true,
      placeholderText: '分组名称',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await store.createGroup(res.content);
          this.refresh();
        } catch (error) {
          wx.showToast({ title: error.message || '创建失败', icon: 'none' });
        }
      },
    });
  },

  onGroupLongPress(event) {
    const { id, name, default: isDefault } = event.currentTarget.dataset;
    if (isDefault) {
      wx.showToast({ title: '默认分组不能改', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: ['重命名', '删除分组'],
      success: (res) => {
        if (res.tapIndex === 0) {
          wx.showModal({
            title: '重命名分组',
            editable: true,
            content: name,
            success: async (modal) => {
              if (!modal.confirm) return;
              try {
                await store.renameGroup(id, modal.content);
                this.refresh();
              } catch (error) {
                wx.showToast({ title: error.message || '失败', icon: 'none' });
              }
            },
          });
        } else if (res.tapIndex === 1) {
          wx.showModal({
            title: '删除分组',
            content: '分组内的密码不会被删除,会退回默认分组。',
            confirmText: '删除',
            confirmColor: '#D93025',
            success: async (modal) => {
              if (!modal.confirm) return;
              try {
                await store.deleteGroup(id);
                if (this.data.activeGroup === id) this.setData({ activeGroup: '' });
                this.refresh();
              } catch (error) {
                wx.showToast({ title: error.message || '失败', icon: 'none' });
              }
            },
          });
        }
      },
      fail: () => {},
    });
  },

  onEdit(event) {
    wx.navigateTo({ url: '/pages/password-edit/password-edit?id=' + event.currentTarget.dataset.id });
  },

  onAdd() {
    this.onCloseAddMenu();
    const group = this.data.activeGroup ? '?group=' + this.data.activeGroup : '';
    wx.navigateTo({ url: '/pages/password-edit/password-edit' + group });
  },

  onImportPasswords() {
    this.onCloseAddMenu();
    wx.showModal({
      title: '导入密码本',
      content: '微信小程序只能从聊天文件中选择。建议先把密码本文件发送到“文件传输助手”，再在这里选择文件。',
      // confirmText 最多 4 个字,超了 showModal 会直接 fail、弹不出来
      confirmText: '选择文件',
      success: (modal) => {
        if (!modal.confirm) return;
        wx.chooseMessageFile({
          count: 1,
          type: 'file',
          extension: ['.bak'],
          success: (res) => {
            const file = res.tempFiles && res.tempFiles[0];
            if (file && file.path) this.importBackupFile(file.path);
          },
          fail: (error) => {
            if (error && /cancel/i.test(error.errMsg || '')) return;
            wx.showToast({ title: '未选择备份文件', icon: 'none' });
          },
        });
      },
    });
  },

  importBackupFile(filePath) {
    const fs = wx.getFileSystemManager();
    fs.readFile({
      filePath,
      success: (res) => {
        const container = new Uint8Array(res.data);
        if (!backup.isContainer(container)) {
          wx.showModal({ title: '文件格式不对', content: '请选择“密扫 OTP”导出的加密备份文件。', showCancel: false });
          return;
        }
        wx.showModal({
          title: '输入备份密码',
          editable: true,
          password: true,
          placeholderText: '请输入备份密码',
          confirmText: '导入',
          success: async (modal) => {
            if (!modal.confirm) return;
            const password = modal.content || '';
            // 允许用户在设置中明确选择的空备份密码；输入框留空即按空密码尝试解密。
            wx.showLoading({ title: '正在解密…', mask: true });
            try {
              const snapshot = await backup.decrypt(container, password);
              const counts = await store.restoreSnapshot(snapshot);
              wx.hideLoading();
              wx.showModal({
                title: '导入完成',
                content: `密码 ${counts.passwords} 条、验证码 ${counts.otpTokens} 条已更新。`,
                showCancel: false,
                success: () => {
                  this.refresh();
                },
              });
            } catch (error) {
              wx.hideLoading();
              wx.showModal({ title: '导入失败', content: error.message || '备份密码错误或文件已损坏', showCancel: false });
            }
          },
        });
      },
      fail: () => wx.showToast({ title: '读取备份文件失败', icon: 'none' }),
    });
  },

  onExportPasswords() {
    this.onCloseAddMenu();
    wx.showModal({
      title: '导出密码本',
      content: '导出后建议将文件发送到“文件传输助手”保存，之后可从聊天文件中选择并导入。',
      confirmText: '继续导出',
      success: (modal) => {
        if (modal.confirm) wx.navigateTo({ url: '/pages/backup/backup?mode=wechat&action=export' });
      },
    });
  },

  onGenerationRecords() {
    this.onCloseAddMenu();
    wx.navigateTo({ url: '/pages/generator/generator?history=1' });
  },

  onLedgerTouchStart(event) {
    // 正在拖条目排序时,别把这次滑动当成上下 fling 手势
    if (this.dragger().isDragging()) { this.ledgerTouchStart = null; return; }
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    this.ledgerTouchStart = { x: touch.clientX, y: touch.clientY, time: Date.now() };
  },

  onLedgerTouchEnd(event) {
    if (this.justDragged()) { this.ledgerTouchStart = null; return; }
    const start = this.ledgerTouchStart;
    const touch = event.changedTouches && event.changedTouches[0];
    this.ledgerTouchStart = null;
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const elapsed = Math.max(1, Date.now() - start.time);
    const distance = Math.abs(dy);
    const speed = distance / elapsed;
    // 对齐安卓 GestureDetector：只把快速、明显的垂直 fling 认作手势；普通滚动只滚动列表。
    if (distance < 100 || distance < Math.abs(dx) * 1.2 || elapsed > 450 || speed < 1.2) return;
    if (dy > 0) {
      this.setData({ searchActive: true, addMenuVisible: false, filterVisible: false });
    } else {
      this.setData({ searchActive: false, addMenuVisible: true, filterVisible: false });
    }
  },

  onCloseAddMenu() {
    this.setData({ addMenuVisible: false });
  },

  noop() {},

  onCopyPassword(event) {
    if (this.justDragged()) return;
    const item = store.getPassword(event.currentTarget.dataset.id);
    if (!item || !item.password) {
      wx.showToast({ title: '这条没有密码', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: item.password,
      success: () => {
        if (this.copyFeedbackTimer) clearTimeout(this.copyFeedbackTimer);
        this.setData({ copiedId: item.id });
        this.copyFeedbackTimer = setTimeout(() => this.setData({ copiedId: '' }), 1800);
        // 小程序没有后台定时器,做不到"N 秒后自动清空剪贴板"。
        // 既然清不掉,至少明确提醒用户剪贴板里有敏感内容。
        if (store.getSettings().clipboardHint) {
          wx.showToast({ title: '密码已复制 · 请尽快粘贴', icon: 'none', duration: 2500 });
        }
      },
    });
  },

  onLongPress(event) {
    const id = event.currentTarget.dataset.id;
    const item = store.getPassword(id);
    if (!item) return;

    // 手动排序模式下,长按是"抓起来拖",不弹操作表 ——
    // 其余排序方式下顺序由规则决定,拖了也留不住。
    if (this.data.sort === 'manual' && this.data.items.length > 1) {
      const patch = this.dragger().start(this.data.items, id, event.touches && event.touches[0]);
      if (patch) {
        this.setData(patch);
        if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
      }
      return;
    }

    const actions = ['复制密码', '复制账号', '编辑', '删除'];
    wx.showActionSheet({
      itemList: actions,
      success: (res) => {
        if (res.tapIndex === 0) {
          this.onCopyPassword(event);
        } else if (res.tapIndex === 1) {
          wx.setClipboardData({ data: item.username || '' });
        } else if (res.tapIndex === 2) {
          this.onEdit(event);
        } else if (res.tapIndex === 3) {
          wx.showModal({
            title: '删除凭证',
            content: `「${item.title || item.site}」将移入回收站。`,
            confirmText: '删除',
            confirmColor: '#D93025',
            success: async (modal) => {
              if (!modal.confirm) return;
              await store.deletePassword(item.id);
              wx.showToast({ title: '已移入回收站', icon: 'none' });
              this.refresh();
            },
          });
        }
      },
      fail: () => {},
    });
  },

});
