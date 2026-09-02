/*
 * 应用主题同步。
 * WXSS 的 prefers-color-scheme 只能跟随系统，不能读取用户保存的 theme 设置。
 * 这里将解析后的主题下发为页面根容器 class，让手动浅色/深色也能覆盖系统主题。
 */

function systemTheme() {
  try {
    const info = wx.getSystemInfoSync ? wx.getSystemInfoSync() : null;
    return info && info.theme === 'dark' ? 'dark' : 'light';
  } catch (error) {
    return 'light';
  }
}

/**
 * 算出最终该用哪套配色。
 *
 * `system` 不传时必须**主动去问系统**，不能当成浅色。
 * 原来这里是 `system === 'dark' ? 'dark' : 'light'`，而 app.js 里
 * onLaunch / onShow / ready() 调 applyTheme() 都是不带参数的，
 * 于是「跟随系统」+ 系统深色的组合冷启动时一律显示浅色，
 * 只有等系统主题**变化**触发 onThemeChange 才会纠正过来。
 */
function resolve(theme, system) {
  if (theme === 'dark' || theme === 'light') return theme;
  const actual = system || systemTheme();
  return actual === 'dark' ? 'dark' : 'light';
}

function pageClass(theme, system) {
  return resolve(theme, system) === 'dark' ? 'app-theme-dark' : 'app-theme-light';
}

/**
 * 导航栏配色。必须和页面背景同色，否则页眉和页面之间会有一条色差接缝。
 *
 * 之前全乱了：页面背景有五种「几乎白」(#FFFFFF / #F4F7FC / #F5F8FC /
 * #F7F8FD / #f6f9fc)、三种「几乎黑」(#0F172A / #08111F / #06101F)，
 * 导航栏又单独取了设置页那一档，于是浅色下页眉偏灰、主页纯白。
 * 现在全部收敛到下面这一组。
 *
 * 选 #F4F7FC 而不是纯白：卡片是 #FFFFFF，页面底色带一点灰才能把卡片
 * 衬出来；纯白页面上白卡片只剩阴影可辨。
 *
 * 这四处的值必须一致，改一处就要改其余三处：
 *   这里
 *   theme.json                                  （系统按 darkmode 自动套用）
 *   app.json 的 window.navigationBarBackgroundColor（未启用 darkmode 时的兜底）
 *   styles/colors.wxss 的三个 *-page-background / *-ledger-background
 */
const NAV_BACKGROUND = { light: '#F4F7FC', dark: '#0F172A' };

function chrome(theme, system) {
  const resolved = resolve(theme, system);
  return resolved === 'dark'
    ? { resolved, backgroundColor: NAV_BACKGROUND.dark, frontColor: '#ffffff' }
    : { resolved, backgroundColor: NAV_BACKGROUND.light, frontColor: '#000000' };
}

function currentPages() {
  try { return typeof getCurrentPages === 'function' ? getCurrentPages() : []; } catch (error) { return []; }
}

function syncPage(page, theme, system) {
  if (!page || !page.setData) return pageClass(theme, system);
  const className = pageClass(theme, system);
  page.setData({ appThemeClass: className });
  return className;
}

function apply(theme, system) {
  const palette = chrome(theme, system);
  if (typeof wx !== 'undefined') {
    if (wx.setBackgroundColor) {
      wx.setBackgroundColor({
        backgroundColor: palette.backgroundColor,
        backgroundColorTop: palette.backgroundColor,
        backgroundColorBottom: palette.backgroundColor,
      });
    }
    if (wx.setNavigationBarColor) wx.setNavigationBarColor({ frontColor: palette.frontColor, backgroundColor: palette.backgroundColor });
  }
  currentPages().forEach((page) => syncPage(page, palette.resolved, palette.resolved));
  return palette;
}

module.exports = { systemTheme, resolve, pageClass, chrome, syncPage, apply };
