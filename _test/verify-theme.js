const assert = require('assert');
const theme = require('../utils/theme.js');

const calls = [];
const pages = [
  { data: {}, setData(patch) { Object.assign(this.data, patch); } },
  { data: {}, setData(patch) { Object.assign(this.data, patch); } },
];

global.wx = {
  getSystemInfoSync: () => ({ theme: 'dark' }),
  setBackgroundColor: (options) => calls.push(['background', options]),
  setNavigationBarColor: (options) => calls.push(['navigation', options]),
};
global.getCurrentPages = () => pages;

function check(name, actual, expected) {
  assert.deepStrictEqual(actual, expected, name);
  console.log(`✓ ${name}`);
}

check('解析手动深色', theme.resolve('dark', 'light'), 'dark');
check('解析手动浅色', theme.resolve('light', 'dark'), 'light');
check('解析跟随系统', theme.resolve('system', 'dark'), 'dark');
check('读取系统深色', theme.systemTheme(), 'dark');

let palette = theme.apply('dark', 'light');
check('手动深色解析正确', palette.resolved, 'dark');
check('手动深色同步所有页面', pages.map((page) => page.data.appThemeClass), ['app-theme-dark', 'app-theme-dark']);
check('手动深色更新导航文字色', calls.find((call) => call[0] === 'navigation')[1].frontColor, '#ffffff');

calls.length = 0;
palette = theme.apply('light', 'dark');
check('手动浅色覆盖深色系统', palette.resolved, 'light');
check('手动浅色同步所有页面', pages.map((page) => page.data.appThemeClass), ['app-theme-light', 'app-theme-light']);
check('手动浅色更新导航文字色', calls.find((call) => call[0] === 'navigation')[1].frontColor, '#000000');

calls.length = 0;
palette = theme.apply('system', 'dark');
check('跟随系统解析深色', palette.resolved, 'dark');
check('跟随系统同步深色类', pages[0].data.appThemeClass, 'app-theme-dark');

// ---- 页眉与页面必须同色 ----
// 这四处各写各的曾经导致：浅色下页眉偏灰、主页纯白；深色下页眉比页面更黑。
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const NAV_LIGHT = '#F4F7FC';
const NAV_DARK = '#0F172A';

check('theme.js 浅色导航栏', theme.chrome('light').backgroundColor, NAV_LIGHT);
check('theme.js 深色导航栏', theme.chrome('dark').backgroundColor, NAV_DARK);

const themeJson = JSON.parse(read('theme.json'));
check('theme.json 浅色导航栏', themeJson.light.navigationBarBackgroundColor, NAV_LIGHT);
check('theme.json 深色导航栏', themeJson.dark.navigationBarBackgroundColor, NAV_DARK);
check('theme.json 浅色页面底', themeJson.light.backgroundColor, NAV_LIGHT);
check('theme.json 深色页面底', themeJson.dark.backgroundColor, NAV_DARK);

const appJson = JSON.parse(read('app.json'));
check('app.json 兜底导航栏', appJson.window.navigationBarBackgroundColor, NAV_LIGHT);

// colors.wxss 里三个页面级 token，在四个作用域下都要等于同一个值
const css = read('styles/colors.wxss');
const TOKENS = ['primary-page-background', 'settings-page-background', 'password-ledger-background'];
for (const t of TOKENS) {
  const values = [...css.matchAll(new RegExp('--' + t + '\\s*:\\s*([^;]+);', 'g'))].map((m) => m[1].trim());
  const light = values.filter((v) => v.toUpperCase() === NAV_LIGHT);
  const dark = values.filter((v) => v.toUpperCase() === NAV_DARK);
  check(`--${t} 只有这两种值`, light.length + dark.length, values.length);
}

// 页面样式里不能再出现写死的页面背景
const pagesDir = path.join(root, 'pages');
const hardcoded = [];
for (const dir of fs.readdirSync(pagesDir)) {
  const f = path.join(pagesDir, dir, dir + '.wxss');
  if (!fs.existsSync(f)) continue;
  const m = fs.readFileSync(f, 'utf8').match(/\.page\s*\{[^}]*background\s*:\s*([^;}]+)/);
  if (m && !m[1].includes('var(')) hardcoded.push(`${dir}: ${m[1].trim()}`);
}
check('没有写死页面背景的页面', hardcoded.join(', '), '');

console.log('主题同步测试通过：22 项');
