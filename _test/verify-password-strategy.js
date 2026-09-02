'use strict';

const strategy = require('../utils/password-strategy.js');

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  if (String(actual) === String(expected)) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      实际: ${actual}\n      期望: ${expected}`); }
}

console.log('\n本地密码策略');
const all = strategy.list();
check('提供四种预设', all.length, 4);
check('预设 id 唯一', new Set(all.map((item) => item.id)).size, 4);
const daily = strategy.get('daily');
check('日常账号为 16 位', daily.options.length, 16);
check('日常账号四类字符全启用', daily.options.includeLower && daily.options.includeUpper && daily.options.includeDigits && daily.options.includeSymbols, 'true');
const important = strategy.get('important');
check('重要账号为 20 位', important.options.length, 20);
const manual = strategy.get('manual');
check('手抄预设排除 0/O', manual.options.excludeZeroO, 'true');
check('手抄预设排除 1/I', manual.options.excludeOneI, 'true');
check('手抄预设有解释', manual.reason.length > 20 && manual.tip.length > 10, 'true');
const temporary = strategy.get('temporary');
check('临时预设为 14 位', temporary.options.length, 14);
const fallback = strategy.get('unknown');
check('未知预设回退日常', fallback.id, 'daily');
const first = strategy.get('daily');
first.options.length = 99;
check('预设选项不会被外部修改', strategy.get('daily').options.length, 16);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
