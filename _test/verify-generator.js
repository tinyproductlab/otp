/* 验证 utils/random.js + utils/generator.js。运行: node _test/verify-generator.js */
const random = require('../utils/random.js');
const gen = require('../utils/generator.js');

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

function throws(fn) {
  try { fn(); return false; } catch (e) { return true; }
}

(async () => {
  console.log('\n随机数池');
  check('未播种时同步取用抛错', throws(() => random.bytesSync(16)), 'true');
  await random.prefetch();
  check('播种后可同步取用', random.bytesSync(32).length, 32);
  check('大请求不受缓冲限制', random.bytesSync(100000).length, 100000);
  check('连续取用不重复', (() => {
    const a = Array.from(random.bytesSync(16)).join(',');
    const b = Array.from(random.bytesSync(16)).join(',');
    return a !== b;
  })(), 'true');
  check('异步取超大块', (await random.bytes(8192)).length, 8192);

  console.log('\n无偏采样(拒绝采样)');
  // 取模偏置检验:对 max=3,直接 %3 会让 0 明显偏多。
  // 卡方式粗检:10 万次采样,每档偏离期望不应超过 2%。
  {
    const max = 3;
    const counts = new Array(max).fill(0);
    const rounds = 100000;
    for (let i = 0; i < rounds; i++) counts[random.intBelowSync(max)]++;
    const expectedEach = rounds / max;
    const worst = Math.max(...counts.map((c) => Math.abs(c - expectedEach) / expectedEach));
    console.log(`  分布 ${counts.join(' / ')},最大偏离 ${(worst * 100).toFixed(2)}%`);
    check('max=3 分布均匀(偏离<2%)', worst < 0.02, 'true');
  }
  {
    // max=10 也是典型偏置场景(256 % 10 = 6)
    const max = 10;
    const counts = new Array(max).fill(0);
    const rounds = 100000;
    for (let i = 0; i < rounds; i++) counts[random.intBelowSync(max)]++;
    const expectedEach = rounds / max;
    const worst = Math.max(...counts.map((c) => Math.abs(c - expectedEach) / expectedEach));
    console.log(`  最大偏离 ${(worst * 100).toFixed(2)}%`);
    check('max=10 分布均匀(偏离<3%)', worst < 0.03, 'true');
  }
  check('max=1 恒为 0', random.intBelowSync(1), 0);
  check('max=0 抛错', throws(() => random.intBelowSync(0)), 'true');
  check('max 非整数抛错', throws(() => random.intBelowSync(3.5)), 'true');

  // 曾经的 bug:limit = floor(256/max)*max 在 max>256 时等于 0,
  // "字节 < 0"永远不成立,于是必然抛"随机数采样失败"。
  console.log('\n大 max(超过单字节)');
  {
    check('max=256 可用', random.intBelowSync(256) < 256, 'true');
    check('max=257 可用', random.intBelowSync(257) < 257, 'true');
    check('max=1000 可用', random.intBelowSync(1000) < 1000, 'true');
    check('max=70000 可用(需 3 字节)', random.intBelowSync(70000) < 70000, 'true');
    // 取值要真的铺满整个区间,不能只落在低位
    const big = 5000;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 4000; i++) {
      const v = random.intBelowSync(big);
      if (v < 0 || v >= big) { min = -1; break; }
      if (v < min) min = v;
      if (v > max) max = v;
    }
    check('max=5000 取值全在区间内', min >= 0, 'true');
    console.log(`      (min=${min} max=${max}，区间 0..${big - 1})`);
    check('max=5000 覆盖到区间两端', min < big * 0.05 && max > big * 0.95, 'true');
    // 洗一个 300 元素的数组 —— 修复前这里直接抛错
    const long = Array.from({ length: 300 }, (_, i) => i);
    const shuffledLong = random.shuffleSync(long.slice());
    check('可洗超过 256 元素的数组',
      shuffledLong.slice().sort((a, b) => a - b).join(',') === long.join(','), 'true');
    check('300 元素数组确实被打乱', shuffledLong.join(',') !== long.join(','), 'true');
  }

  console.log('\n洗牌');
  {
    // 洗牌必须是置换:元素集合不变
    const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const shuffled = random.shuffleSync(original.slice());
    check('保持元素集合', shuffled.slice().sort((a, b) => a - b).join(','), original.join(','));
    // 100 次里至少有一次顺序不同(否则说明没洗)
    let changed = 0;
    for (let i = 0; i < 100; i++) {
      if (random.shuffleSync(original.slice()).join(',') !== original.join(',')) changed++;
    }
    check('确实打乱了', changed > 90, 'true');
  }

  console.log('\n密码生成 —— 长度');
  [1, 4, 8, 16, 32, 64, 128].forEach((length) => {
    check(`length=${length}`, gen.generate({ length }).length, length);
  });
  check('length 上限 128', gen.generate({ length: 999 }).length, 128);
  check('length 下限 1', gen.generate({ length: 0 }).length, 1);

  console.log('\n密码生成 —— 字符集');
  check('仅小写', /^[a-z]+$/.test(gen.generate({ length: 40, includeUpper: false, includeDigits: false, includeSymbols: false })), 'true');
  check('仅大写', /^[A-Z]+$/.test(gen.generate({ length: 40, includeLower: false, includeDigits: false, includeSymbols: false })), 'true');
  check('仅数字', /^\d+$/.test(gen.generate({ length: 40, includeLower: false, includeUpper: false, includeSymbols: false })), 'true');
  check('仅符号', /^[!@#$%^&*]+$/.test(gen.generate({ length: 40, includeLower: false, includeUpper: false, includeDigits: false })), 'true');
  check('全不选返回空', gen.generate({ includeLower: false, includeUpper: false, includeDigits: false, includeSymbols: false }), '');

  console.log('\n密码生成 —— 每类至少一个');
  {
    // 长度 4、四类全开 → 必须每类恰好一个
    let allSatisfied = true;
    for (let i = 0; i < 300; i++) {
      const pw = gen.generate({ length: 4 });
      if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw) || !/[!@#$%^&*]/.test(pw)) {
        allSatisfied = false;
        console.log(`      反例: ${pw}`);
        break;
      }
    }
    check('length=4 四类齐全 ×300', allSatisfied, 'true');
  }
  {
    let allSatisfied = true;
    for (let i = 0; i < 300; i++) {
      const pw = gen.generate({ length: 16 });
      if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw) || !/[!@#$%^&*]/.test(pw)) {
        allSatisfied = false; break;
      }
    }
    check('length=16 四类齐全 ×300', allSatisfied, 'true');
  }

  console.log('\n密码生成 —— 排除形近字符');
  {
    let ok = true;
    for (let i = 0; i < 200; i++) {
      const pw = gen.generate({ length: 60, excludeZeroO: true, excludeLowerO: true, excludeOneI: true, excludeLowerL: true });
      if (/[0O o1Il]/.test(pw.replace(/ /g, ''))) { ok = false; console.log(`      反例: ${pw}`); break; }
    }
    check('全部排除项生效 ×200', ok, 'true');
  }
  check('仅排除 0O', !/[0O]/.test(gen.generate({ length: 80, excludeZeroO: true })), 'true');

  console.log('\n密码生成 —— 不重复');
  {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) seen.add(gen.generate({ length: 16 }));
    check('2000 次无碰撞', seen.size, 2000);
  }

  console.log('\n强度评分');
  check('空密码 0', gen.strengthScore(''), 0);
  check('"abc" 弱', gen.strengthScore('abc'), 15);
  check('"abcdefgh" ', gen.strengthScore('abcdefgh'), 35);
  check('"Abcdefgh1!" ', gen.strengthScore('Abcdefgh1!'), 80);
  check('"Abcdefghijk1!" 满分', gen.strengthScore('Abcdefghijk1!'), 100);
  check('分档 强', gen.strengthLevel('Abcdefghijk1!').level, 'strong');
  check('分档 弱', gen.strengthLevel('abc').level, 'weak');
  check('生成的 16 位默认密码是 strong', gen.strengthLevel(gen.generate({ length: 16 })).level, 'strong');

  console.log('\n配置摘要');
  check('默认', gen.describeOptions(), '16 位 · 小写/大写/数字/符号');
  check('带排除', gen.describeOptions({ length: 20, excludeZeroO: true, excludeOneI: true }), '20 位 · 小写/大写/数字/符号 · 排除 0O,1I');
  check('仅数字', gen.describeOptions({ length: 6, includeLower: false, includeUpper: false, includeSymbols: false }), '6 位 · 数字');

  console.log(`\n${'='.repeat(46)}`);
  console.log(fail === 0 ? `全部通过 (${pass}/${pass})` : `通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
