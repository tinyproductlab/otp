/* 验证 utils/token-view.js。运行: node _test/verify-token-view.js */
const tokenView = require('../utils/token-view.js');
const totp = require('../utils/totp.js');

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  if (String(actual) === String(expected)) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}\n      实际: ${actual}\n      期望: ${expected}`);
  }
}

const SECRET = 'JBSWY3DPEHPK3PXP';
function token(overrides) {
  return Object.assign({
    id: 'id-1', issuer: 'GitHub', accountName: 'me@example.com',
    secret: SECRET, digits: 6, period: 30, algorithm: 'SHA1', pinned: false,
    createdAt: 1756200000000, updatedAt: 1756200000000, notes: '内部备注',
  }, overrides);
}

// 固定到一个周期的起点,方便推算翻页时刻
const T0 = 1756200000000 - (1756200000000 % 30000);

console.log('视图模型只包含渲染层需要的字段');
{
  const list = tokenView.createTokenList();
  const [view] = list.build([token()], T0);
  const keys = Object.keys(view).sort();
  check('字段集合固定', keys.join(','),
    'accountName,display,id,initial,issuer,percent,pinned,remaining');
  // 关键:密钥绝不进渲染层数据
  check('不含 secret', 'secret' in view, 'false');
  check('不含 algorithm', 'algorithm' in view, 'false');
  check('不含 notes', 'notes' in view, 'false');
  check('不含 rawCode', 'rawCode' in view, 'false');
  // pinned 例外:otp.wxml 的置顶样式(is-pinned)在模板里判断,必须过桥
  check('含 pinned(模板要用)', view.pinned, 'false');
  const [pinnedView] = tokenView.createTokenList().build([token({ pinned: true })], T0);
  check('pinned 为 true 时如实传递', pinnedView.pinned, 'true');
  check('首字母正确', view.initial, 'G');
  check('验证码是 6 位带空格', /^\d{3} \d{3}$/.test(view.display), 'true');
}

console.log('\ndecorate 可以补静态字段');
{
  const list = tokenView.createTokenList({ decorate: (item) => ({ brandColor: '#' + item.id }) });
  const [view] = list.build([token()], T0);
  check('额外字段进了视图', view.brandColor, '#id-1');
}

console.log('\nmasked 模式');
{
  const list = tokenView.createTokenList({ masked: true });
  const [view] = list.build([token()], T0);
  check('默认盖成圆点', /^•{3} •{3}$/.test(view.display), 'true');
  const patch = list.displayPatch([view], 'id-1');
  check('展开后露出明文', /^\d{3} \d{3}$/.test(patch['tokens[0].display']), 'true');
  check('展开只改 display 一个字段', Object.keys(patch).join(','), 'tokens[0].display');
  check('明文与 codeOf 一致',
    patch['tokens[0].display'].replace(' ', ''), list.codeOf('id-1'));
}

console.log('\ncodeOf / itemOf 只在逻辑层可用');
{
  const list = tokenView.createTokenList();
  list.build([token()], T0);
  check('codeOf 返回纯数字', /^\d{6}$/.test(list.codeOf('id-1')), 'true');
  check('codeOf 与 totp.code 一致', list.codeOf('id-1'), totp.code(token(), T0));
  check('itemOf 能拿到 pinned', list.itemOf('id-1').pinned, 'false');
  check('itemOf 能拿到密钥', list.itemOf('id-1').secret, SECRET);
  check('未知 id 返回空', list.codeOf('nope'), '');
  check('未知 id 的 itemOf 为 null', list.itemOf('nope'), 'null');
}

console.log('\ntick 只产出变化的字段');
{
  const list = tokenView.createTokenList();
  const tokens = list.build([token()], T0);
  check('起点 remaining=30', tokens[0].remaining, 30);

  // 同一秒内再 tick:什么都没变
  check('同一时刻 tick 返回 null', list.tick(tokens, T0), 'null');

  // 过 1 秒:只有 remaining/percent 变,display 不变
  let patch = list.tick(tokens, T0 + 1000);
  check('过 1 秒只改 remaining 和 percent',
    Object.keys(patch).sort().join(','), 'tokens[0].percent,tokens[0].remaining');
  check('remaining 减 1', patch['tokens[0].remaining'], 29);
  check('补丁里没有 display', 'tokens[0].display' in patch, 'false');

  // 周期翻页:display 也要变
  Object.assign(tokens[0], { remaining: 1, percent: 3 });
  patch = list.tick(tokens, T0 + 30000);
  check('翻页时 display 一起更新', 'tokens[0].display' in patch, 'true');
  check('翻页后的码与 totp.code 一致',
    patch['tokens[0].display'].replace(' ', ''), totp.code(token(), T0 + 30000));
  check('翻页后 codeOf 也跟着更新', list.codeOf('id-1'), totp.code(token(), T0 + 30000));
}

console.log('\n数据被改过时要求重建');
{
  const list = tokenView.createTokenList();
  const tokens = list.build([token()], T0);
  const stale = tokens.concat([{ id: '别的id', remaining: 5, percent: 20, display: '' }]);
  check('runtime 里没有的条目 → rebuild', list.tick(stale, T0 + 1000), 'rebuild');
}

console.log('\n坏密钥不显示假验证码');
{
  const list = tokenView.createTokenList();
  const [view] = list.build([token({ secret: '!!!!' })], T0);
  check('显示密钥错误', view.display, tokenView.CODE_ERROR);
  check('codeOf 返回空,复制会被挡住', list.codeOf('id-1'), '');
  // 不支持的算法同样不能出码(以前会静默按 SHA1 算)
  const list2 = tokenView.createTokenList();
  const [view2] = list2.build([token({ algorithm: 'SHA512' })], T0);
  check('不支持的算法显示密钥错误', view2.display, tokenView.CODE_ERROR);
  check('不支持的算法 codeOf 为空', list2.codeOf('id-1'), '');
}

console.log('\n格式化');
{
  check('6 位', tokenView.formatCode('123456'), '123 456');
  check('7 位', tokenView.formatCode('1234567'), '1234 567');
  check('8 位', tokenView.formatCode('12345678'), '1234 5678');
}

console.log('\n自定义周期');
{
  const list = tokenView.createTokenList();
  const tokens = list.build([token({ period: 60 })], T0);
  check('period=60 的起点 remaining', tokens[0].remaining, 60);
  check('percent 按自身周期算', tokens[0].percent, 100);
  const patch = list.tick(tokens, T0 + 30000);
  check('30 秒后 period=60 的码没变', 'tokens[0].display' in patch, 'false');
}

console.log('\n多条令牌的索引路径正确');
{
  const list = tokenView.createTokenList();
  const source = [token({ id: 'a' }), token({ id: 'b', period: 60 }), token({ id: 'c' })];
  const tokens = list.build(source, T0);
  check('三条都建出来', tokens.length, 3);
  const patch = list.tick(tokens, T0 + 1000);
  check('补丁路径带正确下标',
    Object.keys(patch).sort().join(','),
    'tokens[0].percent,tokens[0].remaining,tokens[1].percent,tokens[1].remaining,tokens[2].percent,tokens[2].remaining');
}

console.log('\n载荷对比(这是做这个模块的原因)');
{
  const list = tokenView.createTokenList({ masked: true, decorate: () => ({ brandColor: '#B87B68' }) });
  const source = Array.from({ length: 60 }, (_, i) => token({ id: 'id-' + i }));
  const tokens = list.build(source, T0);
  const fullBytes = JSON.stringify(tokens).length;
  const oldBytes = JSON.stringify(source.map((item, i) => Object.assign({}, item, tokens[i], { rawCode: '123456', swipeOffset: 0 }))).length;
  const tickBytes = JSON.stringify(list.tick(tokens, T0 + 1000)).length;
  console.log(`      旧做法每秒全量: ${oldBytes} 字节`);
  console.log(`      新做法每秒增量: ${tickBytes} 字节`);
  console.log(`      (全量重建仍需 ${fullBytes} 字节，但只在数据变化时发生)`);
  check('每秒载荷降到旧做法的 1/5 以下', tickBytes * 5 < oldBytes, 'true');
}

console.log(`\n${'='.repeat(46)}`);
console.log(fail === 0 ? `全部通过 (${pass}/${pass})` : `通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
