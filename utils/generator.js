/**
 * 密码生成器
 *
 * 逻辑移植自安卓 utils/PasswordGeneratorEngine.java,两处改动:
 *   1. SecureRandom → utils/random.js 的 CSPRNG 池(绝不用 Math.random)
 *   2. 字符选取改用**拒绝采样**,消除取模偏置 —— 安卓的 nextInt(n) 本身无偏,
 *      但 JS 里若写成 bytes[0] % n 会让靠前字符概率偏高,系统性削弱强度
 */

const random = require('./random.js');

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*';

const DEFAULT_OPTIONS = {
  length: 16,
  includeLower: true,
  includeUpper: true,
  includeDigits: true,
  includeSymbols: true,
  // 排除形近字符,抄写场景用
  excludeZeroO: false, // 0 和 O
  excludeLowerO: false, // o
  excludeOneI: false, // 1 和 I
  excludeLowerL: false, // l
};

function filterPool(source, options) {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (options.excludeZeroO && (c === '0' || c === 'O')) continue;
    if (options.excludeLowerO && c === 'o') continue;
    if (options.excludeOneI && (c === '1' || c === 'I')) continue;
    if (options.excludeLowerL && c === 'l') continue;
    out += c;
  }
  return out;
}

/**
 * 生成密码。**调用前请先 await random.prefetch()**。
 * @param {Partial<typeof DEFAULT_OPTIONS>} userOptions
 * @returns {string} 长度不足或未选任何字符集时返回 ''
 */
function generate(userOptions = {}) {
  const options = Object.assign({}, DEFAULT_OPTIONS, userOptions);
  const length = Math.max(1, Math.min(128, options.length | 0));

  const lower = options.includeLower ? filterPool(LOWER, options) : '';
  const upper = options.includeUpper ? filterPool(UPPER, options) : '';
  const digits = options.includeDigits ? filterPool(DIGITS, options) : '';
  const symbols = options.includeSymbols ? SYMBOLS : '';

  const pool = lower + upper + digits + symbols;
  if (!pool) return '';

  // 每个已选类别先保证至少一个,剩下的从全池取
  const chars = [];
  [lower, upper, digits, symbols].forEach((set) => {
    if (set && chars.length < length) chars.push(set[random.intBelowSync(set.length)]);
  });
  while (chars.length < length) chars.push(pool[random.intBelowSync(pool.length)]);

  return random.shuffleSync(chars).join('');
}

/**
 * 强度评分 0-100。与安卓 strengthScore 保持一致的口径。
 * 注意:只看长度和字符类别,不查字典、不算真实熵。够用,别当成真实强度。
 */
function strengthScore(password) {
  if (!password) return 0;
  let score = 0;
  if (password.length >= 8) score += 20;
  if (password.length >= 12) score += 20;
  if (/[a-z]/.test(password)) score += 15;
  if (/[A-Z]/.test(password)) score += 15;
  if (/\d/.test(password)) score += 15;
  if (/[^A-Za-z0-9]/.test(password)) score += 15;
  return Math.min(100, score);
}

/** 强度分档,给 UI 上色 */
function strengthLevel(password) {
  const score = strengthScore(password);
  if (score >= 85) return { level: 'strong', label: '很强', score };
  if (score >= 65) return { level: 'good', label: '较强', score };
  if (score >= 45) return { level: 'fair', label: '一般', score };
  return { level: 'weak', label: '较弱', score };
}

/** 生成时的配置摘要,存进历史记录用(对齐安卓 configSummary) */
function describeOptions(userOptions = {}) {
  const options = Object.assign({}, DEFAULT_OPTIONS, userOptions);
  const parts = [];
  if (options.includeLower) parts.push('小写');
  if (options.includeUpper) parts.push('大写');
  if (options.includeDigits) parts.push('数字');
  if (options.includeSymbols) parts.push('符号');
  const excluded = [];
  if (options.excludeZeroO) excluded.push('0O');
  if (options.excludeLowerO) excluded.push('o');
  if (options.excludeOneI) excluded.push('1I');
  if (options.excludeLowerL) excluded.push('l');
  let summary = `${options.length} 位 · ${parts.join('/') || '无'}`;
  if (excluded.length) summary += ` · 排除 ${excluded.join(',')}`;
  return summary;
}

module.exports = {
  generate,
  strengthScore,
  strengthLevel,
  describeOptions,
  DEFAULT_OPTIONS,
  POOLS: { LOWER, UPPER, DIGITS, SYMBOLS },
};
