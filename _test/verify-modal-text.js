/*
 * 检查所有 wx.showModal 的按钮文案长度。运行: node _test/verify-modal-text.js
 *
 * 为什么要单独立一个检查：confirmText / cancelText 超过 4 个字时，
 * wx.showModal 会**直接 fail、弹窗根本不显示**（errMsg:
 * "confirmText length should not larger than 4 Chinese characters"）。
 * 而绝大多数调用点没写 fail 回调，于是表现就是「点了没反应」——
 * 没有报错、没有日志、没有任何线索，只能靠逐个试才能发现。
 *
 * 这类 bug 静态就能查出来，不该等到用户点不动才发现。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['_test', 'docs', '参考资料', 'node_modules', '.git']);
const MAX_BUTTON_CHARS = 4;

let pass = 0;
let fail = 0;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const problems = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /(confirmText|cancelText)\s*:\s*(['"`])([\s\S]*?)\2/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const [, key, , raw] = m;
    // 模板串里的变量按最坏情况估两个字（数量最多也就两位数）
    const worst = raw.replace(/\$\{[^}]*\}/g, 'XX');
    if (worst.length > MAX_BUTTON_CHARS) {
      problems.push({
        file: path.relative(ROOT, file),
        line: src.slice(0, m.index).split('\n').length,
        key,
        text: raw,
        length: worst.length,
      });
    }
  }
}

console.log(`扫描 ${files.length} 个 js 文件的 showModal 按钮文案（上限 ${MAX_BUTTON_CHARS} 字）\n`);
if (problems.length) {
  for (const p of problems) {
    fail++;
    console.log(`  ✗ ${p.file}:${p.line}  ${p.key} = "${p.text}"  (${p.length} 字，超出 ${p.length - MAX_BUTTON_CHARS})`);
    console.log('      超长会让 showModal 直接 fail，弹窗不显示，表现为「点了没反应」');
  }
} else {
  pass++;
  console.log('  ✓ 所有 confirmText / cancelText 都在 4 字以内');
}

// 顺带查一类相关隐患：用 Promise 包住 showModal 却没写 fail 回调时，
// 弹窗一旦失败这个 Promise 永远不会落地，调用方就静默挂住。
const promiseModals = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /new Promise\(\s*\(([^)]*)\)\s*=>\s*\{([\s\S]{0,900}?)\n\s*\}\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const body = m[2];
    if (!/wx\.showModal\s*\(/.test(body)) continue;
    if (/\bfail\s*:/.test(body)) continue;
    promiseModals.push({
      file: path.relative(ROOT, file),
      line: src.slice(0, m.index).split('\n').length,
    });
  }
}

console.log('');
if (promiseModals.length) {
  for (const p of promiseModals) {
    fail++;
    console.log(`  ✗ ${p.file}:${p.line}  Promise 里的 showModal 没写 fail 回调`);
    console.log('      弹窗失败时这个 Promise 永远不落地，调用方会静默挂住');
  }
} else {
  pass++;
  console.log('  ✓ 所有包在 Promise 里的 showModal 都有 fail 回调');
}

console.log(`\n${'='.repeat(46)}`);
console.log(fail === 0 ? `全部通过 (${pass}/${pass})` : `发现 ${fail} 处问题`);
process.exit(fail === 0 ? 0 : 1);
