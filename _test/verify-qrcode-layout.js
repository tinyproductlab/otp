/* 二维码转换页布局回归检查。运行：node _test/verify-qrcode-layout.js */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'pages', 'qrcode');
const wxml = fs.readFileSync(path.join(root, 'qrcode.wxml'), 'utf8');
const wxss = fs.readFileSync(path.join(root, 'qrcode.wxss'), 'utf8');
const js = fs.readFileSync(path.join(root, 'qrcode.js'), 'utf8');

let pass = 0;
let fail = 0;

function check(name, condition) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}`);
  }
}

console.log('二维码转换页布局');
check('输入框启用原生自动增高', /<textarea[\s\S]*?auto-height[\s\S]*?bindinput="onInput"/.test(wxml));
check('输入框移除默认内边距', /<textarea[\s\S]*?disable-default-padding/.test(wxml));
check('内容存在时切换填充状态样式', /input-card \{\{content \? 'input-card--filled' : ''\}\}/.test(wxml));
check('初始输入高度紧凑', /\.input\s*\{[\s\S]*?min-height:\s*84rpx;/.test(wxss));
const inputStyle = (wxss.match(/\.input\s*\{([^}]*)\}/) || ['', ''])[1];
check('输入区没有固定高度限制', !/(^|\n)\s*height:\s*\d+rpx;/.test(inputStyle));
check('已输入状态有独立边框反馈', /\.input-card--filled\s*\{[\s\S]*?border-color:/.test(wxss));
check('空二维码区域已缩短', /\.qr-placeholder__box\s*\{[\s\S]*?height:\s*320rpx;/.test(wxss));
check('二维码区域保留下载画布', /canvas-id="qrCanvas"/.test(wxml));
check('保留下载按钮', /bindtap="onDownload">下载<\//.test(wxml));
check('美化按钮已移除', !/onBeautify|美化/.test(wxml));
check('美化处理函数已移除', !/onBeautify|qrTone|qrColor/.test(js));
check('色调专用样式已移除', !/tone-(black|blue|green|purple|pink|orange)/.test(wxss));

console.log('==============================================');
console.log(`通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
console.log('全部通过');
