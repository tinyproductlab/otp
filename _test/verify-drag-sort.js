/* 验证 utils/drag-sort.js + store 的重排。运行: node _test/verify-drag-sort.js */
const dragSort = require('../utils/drag-sort.js');
const store = require('../utils/store.js');

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

const ROW = 100; // 测试里把行高钉死，免得依赖真实 DOM
const list = (ids) => ids.map((id) => ({ id }));
const ids = (rows) => rows.map((r) => r.id).join('');

function make(persist) {
  const d = dragSort.createDragSort({ selector: '.x', listKey: 'tokens', persist });
  d._internal.setRowHeight(ROW);
  return d;
}

console.log('抓起与释放');
{
  const d = make();
  const rows = list(['a', 'b', 'c']);
  check('没抓起时 isDragging 为假', d.isDragging(), 'false');
  const patch = d.start(rows, 'b', { clientY: 500 });
  check('抓起返回补丁', JSON.stringify(patch), '{"dragId":"b","dragOffset":0}');
  check('isDragging 为真', d.isDragging(), 'true');
  check('draggingId 正确', d.draggingId(), 'b');
  d.end(rows);
  check('松手后 isDragging 为假', d.isDragging(), 'false');
  check('抓不存在的 id 返回 null', make().start(rows, '不存在', { clientY: 0 }), 'null');
}

console.log('\n跨过半个行高才换位');
{
  const d = make();
  let rows = list(['a', 'b', 'c']);
  d.start(rows, 'a', { clientY: 0 });

  let p = d.move(rows, { clientY: ROW / 2 - 1 }); // 差一点点，不该换
  check('不到一半不换位', 'tokens' in p, 'false');
  check('但偏移量跟手', p.dragOffset, ROW / 2 - 1);

  p = d.move(rows, { clientY: ROW / 2 + 1 });     // 越过一半，换一位
  check('越过一半换位', ids(p.tokens), 'bac');
  rows = p.tokens;
  check('换位后偏移量扣掉一行', Math.round(p.dragOffset), Math.round(ROW / 2 + 1 - ROW));
}

console.log('\n一次滑过多行要逐格换位');
{
  const d = make();
  const rows = list(['a', 'b', 'c', 'd', 'e']);
  d.start(rows, 'a', { clientY: 0 });
  // 一口气拉到第 4 行的位置
  const p = d.move(rows, { clientY: ROW * 3 + 10 });
  check('a 一路挪到第 4 位', ids(p.tokens), 'bcdae');
}

console.log('\n到边界就停下');
{
  const d = make();
  const rows = list(['a', 'b', 'c']);
  d.start(rows, 'a', { clientY: 0 });
  const p = d.move(rows, { clientY: -ROW * 5 });   // 已经在最上面，还往上拉
  check('顶到头不越界', p && p.tokens ? ids(p.tokens) : ids(rows), 'abc');

  const d2 = make();
  const rows2 = list(['a', 'b', 'c']);
  d2.start(rows2, 'c', { clientY: 0 });
  const p2 = d2.move(rows2, { clientY: ROW * 5 }); // 已经在最下面，还往下拉
  check('底到头不越界', p2 && p2.tokens ? ids(p2.tokens) : ids(rows2), 'abc');
}

console.log('\n松手写库 / 中途取消不写库');
{
  let saved = null;
  const d = make((x) => { saved = x; return Promise.resolve(); });
  const rows = list(['a', 'b', 'c']);
  d.start(rows, 'a', { clientY: 0 });
  const moved = d.move(rows, { clientY: ROW });
  const { patch } = d.end(moved.tokens);
  check('松手补丁清空拖动态', JSON.stringify(patch), '{"dragId":"","dragOffset":0}');
  check('写库收到新顺序', (saved || []).join(''), 'bac');

  let saved2 = null;
  const d2 = make((x) => { saved2 = x; return Promise.resolve(); });
  const rows2 = list(['a', 'b', 'c']);
  d2.start(rows2, 'a', { clientY: 0 });
  d2.move(rows2, { clientY: ROW });
  const cancelPatch = d2.cancel();
  check('取消也清空拖动态', JSON.stringify(cancelPatch), '{"dragId":"","dragOffset":0}');
  check('取消不写库', saved2, 'null');
  check('取消后 isDragging 为假', d2.isDragging(), 'false');
}

console.log('\n没抓起时 move / end 都是安全的');
{
  const d = make();
  check('move 返回 null', d.move(list(['a']), { clientY: 10 }), 'null');
  check('end 的 patch 为 null', d.end(list(['a'])).patch, 'null');
}

// ---- store 侧 ----
(async () => {
  console.log('\nstore.reorderOtpTokens');
  store._reset();
  await store.ready();
  for (const n of ['a', 'b', 'c', 'd']) {
    await store.saveOtpToken({ id: n, issuer: n, accountName: n, secret: 'JBSWY3DPEHPK3PXP' });
  }
  const before = store.listOtpTokens().map((x) => x.id);
  console.log('      初始顺序:', before.join(''));

  await store.reorderOtpTokens(['d', 'c', 'b', 'a']);
  check('手动模式按拖出来的顺序', store.listOtpTokens('', 'manual').map((x) => x.id).join(''), 'dcba');
  check('sortOrder 与数组下标一致',
    store.state.otpTokens.every((row, i) => row.sortOrder === i), 'true');

  // 置顶不该打乱手动顺序
  await store.toggleOtpPinned('a');
  check('手动模式下置顶项不插队', store.listOtpTokens('', 'manual').map((x) => x.id).join(''), 'dcba');
  check('默认模式下置顶项仍浮到最前', store.listOtpTokens().map((x) => x.id)[0], 'a');

  // 重排不该改 updatedAt —— 否则"按时间排序"的视图会被搅乱
  const stamps = new Map(store.state.otpTokens.map((r) => [r.id, r.updatedAt]));
  await store.reorderOtpTokens(['a', 'b', 'c', 'd']);
  check('重排不修改 updatedAt',
    store.state.otpTokens.every((r) => r.updatedAt === stamps.get(r.id)), 'true');

  // 子集重排(搜索/筛选后拖的)：没参与的条目位次不变
  await store.reorderOtpTokens(['a', 'b', 'c', 'd']);
  await store.reorderOtpTokens(['d', 'b']);   // 只拖了第 2 和第 4 位这两条
  check('子集重排只换它们自己的位次',
    store.listOtpTokens('', 'manual').map((x) => x.id).join(''), 'adcb');

  check('单条不做任何事', await store.reorderOtpTokens(['a']) === undefined, 'true');
  check('空数组不做任何事', await store.reorderOtpTokens([]) === undefined, 'true');

  console.log('\nstore.reorderPasswords');
  for (const n of ['p1', 'p2', 'p3']) {
    await store.savePassword({ id: n, title: n, password: 'x' });
  }
  await store.reorderPasswords(['p3', 'p2', 'p1']);
  check('手动排序按拖出来的顺序',
    store.listPasswords({ sort: 'manual' }).map((x) => x.id).join(','), 'p3,p2,p1');
  check('按名称排序不受影响',
    store.listPasswords({ sort: 'name' }).map((x) => x.id).join(','), 'p1,p2,p3');

  console.log(`\n${'='.repeat(46)}`);
  console.log(fail === 0 ? `全部通过 (${pass}/${pass})` : `通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e.message, '\n', e.stack); process.exit(1); });
