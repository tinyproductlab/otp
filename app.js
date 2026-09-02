const store = require('./utils/store.js');
const random = require('./utils/random.js');
const theme = require('./utils/theme.js');
const i18n = require('./utils/i18n.js');

// 开着生物识别时,切后台超过这个时长,回来必须重新验证
const RELOCK_AFTER_BACKGROUND_MS = 30 * 1000;

App({
  globalData: {
    ready: false,
    readyError: null,
    unlocked: true,
    unlocking: false,
    locale: 'zh-Hans',
  },

  onLaunch() {
    // 随机数必须先播种,密码生成和备份加密都依赖它。
    // 播种是异步的(wx.getRandomValues 没有同步版),所以放在启动阶段做掉,
    // 后续同步取用不必等待。
    this.readyPromise = random
      .prefetch()
      .then(() => store.ready())
      .then(() => {
        this.globalData.ready = true;
        this.globalData.unlocked = !store.getSettings().biometricLock;
        this.applyLocale();
        this.applyTheme();
      })
      .catch((error) => {
        this.globalData.readyError = error;
        // 读不出数据通常意味着换了设备或清了缓存 —— encrypt 存储的密钥
        // 绑 openid + 设备,换设备就解不开。这是必须让用户知道的情况。
        wx.showModal({
          title: '数据读取失败',
          content:
            (error && error.message ? error.message : '未知错误') +
            '\n\n如果你换了手机或清理过微信缓存,本地数据可能已无法解密。请用之前导出的备份恢复。',
          showCancel: false,
          confirmText: '我知道了',
        });
      });
  },

  onHide() {
    // 记录切后台时刻,onShow 时判断是否需要重新验证
    this._backgroundedAt = Date.now();
  },

  onShow() {
    // 注意走原始 readyPromise 而不是 ready():解锁门挂着时不能再等它自己
    (this.readyPromise || Promise.resolve())
      .then(() => {
        this.applyTheme();
        this.applyLocale();
        return this.maybeRelock();
      })
      .then(() => this.enforceBiometricLock());
  },

  onThemeChange(event) {
    // 仅“跟随系统”模式响应系统外观变化；手动浅色/深色保持用户选择。
    if (store.getSettings().theme === 'system') this.applyTheme(event && event.theme);
  },

  applyTheme(system) {
    return theme.apply(store.getSettings().theme, system);
  },

  /**
   * 读取用户的语言偏好。选“跟随系统”时，每次回到前台都会重新读取系统语言，
   * 因此用户改完手机语言后重新进入小程序即可生效。
   */
  applyLocale() {
    const locale = i18n.resolveLocale(store.getSettings().locale);
    this.globalData.locale = locale;
    return locale;
  },

  /** 开了生物识别、当前是已解锁、且切后台超过阈值 → 打回未解锁状态 */
  maybeRelock() {
    if (store.getSettings().biometricLock !== true || this.globalData.unlocked !== true) return;
    if (!this._backgroundedAt) return;
    if (Date.now() - this._backgroundedAt >= RELOCK_AFTER_BACKGROUND_MS) {
      this.globalData.unlocked = false;
    }
  },

  enforceBiometricLock() {
    if (store.getSettings().biometricLock !== true || this.globalData.unlocked) return;
    this.requireUnlock();
  },

  /**
   * 解锁门:开着生物识别且未解锁时,返回一个挂起的 Promise,
   * 验证通过才 resolve。页面统一走 getApp().ready(),
   * 因此验证完成前任何页面都拿不到数据 —— 锁是门禁,不是建议。
   */
  requireUnlock() {
    if (!this._unlockGate) {
      let resolveGate;
      const promise = new Promise((resolve) => { resolveGate = resolve; });
      this._unlockGate = { promise, resolve: resolveGate };
      this.promptBiometric();
    }
    return this._unlockGate.promise;
  },

  /**
   * 查设备到底能不能验。必须区分三种情况,否则会把用户锁死:
   *   - 不支持(微信版本旧 / 设备没有传感器)
   *   - 支持但**没录入**指纹或面容 ← 这种最坑:startSoterAuthentication 会
   *     直接 fail,用户再怎么点"重试"也永远不可能成功
   *   - 支持且已录入 → 真的可以验
   * 只有第三种才该把用户挡在门外。
   */
  checkBiometricUsable() {
    return new Promise((resolve) => {
      if (!wx.startSoterAuthentication || !wx.checkIsSupportSoterAuthentication) {
        resolve({ usable: false, reason: 'unsupported' });
        return;
      }
      wx.checkIsSupportSoterAuthentication({
        success: (res) => {
          const modes = (res && res.supportMode) || [];
          const supported = modes.filter((m) => m === 'fingerPrint' || m === 'facial');
          if (!supported.length) {
            resolve({ usable: false, reason: 'unsupported' });
            return;
          }
          if (!wx.checkIsSoterEnrolledInDevice) {
            // 查不到录入状态就按能用处理,失败时再由 fail 分支兜底
            resolve({ usable: true, modes: supported });
            return;
          }
          // 逐个模式查录入状态,任一已录入即可
          const probe = (index) => {
            if (index >= supported.length) {
              resolve({ usable: false, reason: 'not-enrolled' });
              return;
            }
            wx.checkIsSoterEnrolledInDevice({
              checkAuthMode: supported[index],
              success: (r) => {
                if (r && r.isEnrolled) resolve({ usable: true, modes: supported });
                else probe(index + 1);
              },
              fail: () => probe(index + 1),
            });
          };
          probe(0);
        },
        fail: () => resolve({ usable: false, reason: 'unsupported' }),
      });
    });
  },

  /**
   * 设备根本没法验时的出口。此时"锁"不提供任何安全性,只会把人关在外面,
   * 所以放行、把开关关掉、并告诉用户原因 —— 而不是让他反复点一个永远失败的重试。
   */
  releaseUnusableLock(reason) {
    const content = reason === 'not-enrolled'
      ? '这台设备还没有录入指纹或面容，生物识别锁定无法生效。已为你关闭该开关；在系统设置里录入后可以重新开启。'
      : '当前微信版本或设备不支持指纹与面容验证。已为你关闭生物识别锁定开关。';
    // 关掉开关是为了下次启动不再撞同一堵墙；写失败也不影响本次放行
    store.updateSettings({ biometricLock: false }).catch(() => {});
    wx.showModal({ title: '生物识别不可用', content, showCancel: false });
    this.resolveUnlock();
  },

  promptBiometric() {
    if (this.globalData.unlocking) return;
    this.globalData.unlocking = true;
    this.checkBiometricUsable().then((status) => {
      if (!status.usable) {
        this.globalData.unlocking = false;
        this.releaseUnusableLock(status.reason);
        return;
      }
      wx.startSoterAuthentication({
        requestAuthModes: status.modes,
        challenge: 'misao-otp-unlock',
        success: () => {
          this.globalData.unlocking = false;
          this.resolveUnlock();
        },
        fail: (err) => {
          this.globalData.unlocking = false;
          // 预检说能用,实际却报"不支持/未录入"——以实际为准,放行。
          // 90002/90003/90010 这类错误码各端不完全一致,所以按文案兜一层。
          const message = (err && (err.errMsg || err.errCode)) || '';
          if (/not\s*support|not\s*enroll|no\s*fingerprint|90002|90003|90010/i.test(String(message))) {
            this.releaseUnusableLock('not-enrolled');
            return;
          }
          // 真的是"验证没通过"(按错/取消):锁是门禁,不是建议,继续要验。
          // 这里不能提供"关闭锁定"的出口,否则任何人都能绕过。
          wx.showModal({
            title: '需要验证身份',
            content: '已开启生物识别锁定，请完成指纹或面容验证后继续使用。',
            confirmText: '重试',
            showCancel: false,
            success: () => this.promptBiometric(),
          });
        },
      });
    });
  },

  resolveUnlock() {
    this.globalData.unlocked = true;
    if (this._unlockGate) {
      const gate = this._unlockGate;
      this._unlockGate = null;
      gate.resolve();
    }
  },

  /** 页面里 await getApp().ready() 确保数据已载入,且(若开启)已通过生物识别 */
  ready() {
    return (this.readyPromise || Promise.resolve()).then(() => {
      this.applyTheme();
      if (store.getSettings().biometricLock === true && !this.globalData.unlocked) {
        return this.requireUnlock();
      }
      return undefined;
    });
  },
});
