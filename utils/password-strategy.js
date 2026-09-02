'use strict';

/**
 * 本地密码策略助手。
 * 根据用户主动选择的使用场景推荐生成器参数；不读取账号、静态密码账本或网络数据，
 * 最终密码仍由 generator.js 的本地随机逻辑生成。
 */

const STRATEGIES = [
  {
    id: 'daily',
    label: '日常账号',
    shortLabel: '日常',
    options: { length: 16, includeLower: true, includeUpper: true, includeDigits: true, includeSymbols: true, excludeZeroO: false, excludeOneI: false, excludeLowerL: false, excludeLowerO: false },
    title: '日常账号：16 位随机密码',
    reason: '适合多数需要长期保存的账号。使用四类字符，并把密码保存在本地账本中，避免手动复用。',
    tip: '如果网站不支持符号，再手动关闭符号开关；不要把长度降到 12 位以下。',
  },
  {
    id: 'important',
    label: '重要账号',
    shortLabel: '重要',
    options: { length: 20, includeLower: true, includeUpper: true, includeDigits: true, includeSymbols: true, excludeZeroO: false, excludeOneI: false, excludeLowerL: false, excludeLowerO: false },
    title: '重要账号：20 位随机密码',
    reason: '适合邮箱、支付、工作与开发者账号。更长的随机密码能降低被猜测或撞库后继续滥用的风险。',
    tip: '为重要账号保留独立密码，并优先启用本小程序中的 TOTP 两步验证。',
  },
  {
    id: 'manual',
    label: '需要手抄',
    shortLabel: '手抄',
    options: { length: 16, includeLower: true, includeUpper: true, includeDigits: true, includeSymbols: true, excludeZeroO: true, excludeOneI: true, excludeLowerL: true, excludeLowerO: true },
    title: '手抄场景：排除易混淆字符',
    reason: '适合必须人工录入的场景。保持随机性，同时排除 0/O、1/I、l/o 等容易看错的字符。',
    tip: '手抄后请立即核对，并尽快保存到静态密码账本；不要为了好记而改用规律密码。',
  },
  {
    id: 'temporary',
    label: '临时一次性',
    shortLabel: '临时',
    options: { length: 14, includeLower: true, includeUpper: true, includeDigits: true, includeSymbols: true, excludeZeroO: false, excludeOneI: false, excludeLowerL: false, excludeLowerO: false },
    title: '临时账号：14 位随机密码',
    reason: '适合有明确有效期的临时服务。即使是临时账号，也不应和长期账号使用相同密码。',
    tip: '到期后请删除账号或更换密码；若服务会自动续费，请按长期账号处理。',
  },
];

function cloneOptions(options) {
  return Object.assign({}, options);
}

function list() {
  return STRATEGIES.map((item) => Object.assign({}, item, { options: cloneOptions(item.options) }));
}

function get(id) {
  const strategy = STRATEGIES.find((item) => item.id === id) || STRATEGIES[0];
  return Object.assign({}, strategy, { options: cloneOptions(strategy.options) });
}

module.exports = { list, get };
