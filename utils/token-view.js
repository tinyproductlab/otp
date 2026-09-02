/**
 * OTP 列表的视图模型 + 每秒增量刷新
 *
 * 首页和 TOTP 列表页原来各自每秒重建整个列表、再全量 setData。两个问题:
 *
 *   1. **跨线程载荷放大**。整条令牌序列化约 330 字节,60 条就是每秒 19KB;
 *      而真正每秒变化的只有 remaining / percent(约 29 字节),放大 11 倍。
 *      小程序的 setData 要跨逻辑层↔渲染层,这一路是最贵的。
 *   2. **验证码 30 秒才变一次,却每秒重算**。HMAC 本身不贵(实测 0.013ms/次),
 *      但没有理由算它。
 *
 * 所以把两件事分开:
 *   - `build()` 数据 / 搜索词 / 排序变化时全量重建
 *   - `tick()`  每秒只产出**变化字段**的定向 setData 补丁,没变化就返回 null
 *
 * 另一件事:密钥(secret)、算法、时间戳这些渲染层用不到的字段一律不进 data,
 * 只留在 JS 侧的 runtime 表里。密钥进渲染层既白占载荷,也会出现在
 * 开发者工具的 WXML 面板上 —— 没有任何好处。
 */

const totp = require('./totp.js');

const CODE_ERROR = '密钥错误';

/** 6 位显示成 "123 456",7/8 位显示成 "1234 567(8)",比一长串好读 */
function formatCode(code) {
  if (code.length >= 7) return code.slice(0, 4) + ' ' + code.slice(4);
  return code.slice(0, 3) + ' ' + code.slice(3);
}

function periodOf(item) {
  return Math.max(1, item.period || 30);
}

/** 当前所处的 TOTP 周期序号。序号不变 ⇒ 验证码不变。 */
function counterOf(item, now) {
  return Math.floor(Math.floor(now / 1000) / periodOf(item));
}

function computeCode(item, now) {
  const counter = counterOf(item, now);
  try {
    return { code: totp.code(item, now), counter, ok: true };
  } catch (error) {
    // 密钥坏了不能悄悄显示一个假验证码
    return { code: '', counter, ok: false };
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.masked] 默认是否把数字盖成圆点(首页要,列表页不要)
 * @param {(item: object) => object} [options.decorate]
 *        额外的**静态**展示字段(如首页的 brandColor)。只在 build 时算一次。
 * @param {string} [options.path] setData 的数组字段名,默认 'tokens'
 */
function createTokenList(options = {}) {
  const masked = !!options.masked;
  const decorate = options.decorate;
  const path = options.path || 'tokens';
  let runtime = new Map(); // id -> { id, item, code, counter, ok }

  function displayOf(entry, revealedId) {
    if (!entry.ok) return CODE_ERROR;
    const formatted = formatCode(entry.code);
    if (!masked || entry.id === revealedId) return formatted;
    return formatted.replace(/[0-9]/g, '•');
  }

  function viewOf(item, entry, now, revealedId) {
    const remaining = totp.remainingSeconds(item, now);
    const view = {
      id: item.id,
      issuer: item.issuer || '',
      accountName: item.accountName || '',
      display: displayOf(entry, revealedId),
      remaining,
      percent: Math.round((remaining / periodOf(item)) * 100),
      initial: (item.issuer || item.accountName || '?').trim().charAt(0).toUpperCase(),
      // pinned 要过桥:TOTP 列表页用它加置顶样式(otp.wxml 的 is-pinned)。
      // 它不是敏感数据,判断在模板里做,所以必须在视图模型里。
      pinned: !!item.pinned,
    };
    return decorate ? Object.assign(view, decorate(item)) : view;
  }

  return {
    /**
     * 全量重建。返回可直接 setData 的数组。
     * @param {object[]} source 来自 store.listOtpTokens 的原始令牌
     */
    build(source, now = Date.now(), revealedId = '') {
      runtime = new Map();
      return source.map((item) => {
        const computed = computeCode(item, now);
        const entry = Object.assign({ id: item.id, item }, computed);
        runtime.set(item.id, entry);
        return viewOf(item, entry, now, revealedId);
      });
    },

    /**
     * 每秒调用。
     * @returns {object|null|'rebuild'}
     *   对象 —— 定向 setData 补丁;
     *   null —— 什么都没变,不必 setData;
     *   'rebuild' —— runtime 表里找不到条目(数据被改过了),调用方应重新 build。
     */
    tick(tokens, now = Date.now(), revealedId = '') {
      const patch = {};
      for (let i = 0; i < tokens.length; i++) {
        const view = tokens[i];
        const entry = runtime.get(view.id);
        if (!entry) return 'rebuild';
        const item = entry.item;

        const remaining = totp.remainingSeconds(item, now);
        if (remaining !== view.remaining) patch[`${path}[${i}].remaining`] = remaining;

        const percent = Math.round((remaining / periodOf(item)) * 100);
        if (percent !== view.percent) patch[`${path}[${i}].percent`] = percent;

        // 只在周期翻页时重算验证码
        if (counterOf(item, now) !== entry.counter) {
          const next = computeCode(item, now);
          entry.code = next.code;
          entry.counter = next.counter;
          entry.ok = next.ok;
        }

        const display = displayOf(entry, revealedId);
        if (display !== view.display) patch[`${path}[${i}].display`] = display;
      }
      return Object.keys(patch).length ? patch : null;
    },

    /** 只刷新 display(展开/收起明文时用),不动倒计时 */
    displayPatch(tokens, revealedId = '') {
      const patch = {};
      for (let i = 0; i < tokens.length; i++) {
        const entry = runtime.get(tokens[i].id);
        if (!entry) continue;
        const display = displayOf(entry, revealedId);
        if (display !== tokens[i].display) patch[`${path}[${i}].display`] = display;
      }
      return Object.keys(patch).length ? patch : null;
    },

    /** 纯数字验证码(复制用)。渲染层拿不到它。 */
    codeOf(id) {
      const entry = runtime.get(id);
      return entry && entry.ok ? entry.code : '';
    },

    /** 原始令牌对象(含密钥),仅供逻辑层使用 */
    itemOf(id) {
      const entry = runtime.get(id);
      return entry ? entry.item : null;
    },
  };
}

module.exports = {
  createTokenList,
  formatCode,
  CODE_ERROR,
  _internal: { computeCode, counterOf, periodOf },
};
