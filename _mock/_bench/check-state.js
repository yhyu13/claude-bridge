// check-state.js — 只读地报告磁盘上 web/ 的真实状态。
// 用脚本而不是 node -e：PowerShell 里带引号的正则会被吃掉。
const fs = require('fs');
const path = require('path');
const WEB = path.join(__dirname, '..', '..', 'web');

const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

function block(src, sel) {
  const i = src.indexOf(sel + ' {');
  if (i < 0) return '(没找到 ' + sel + ')';
  let d = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) break; }
  }
  return src.slice(i, j + 1);
}

console.log('=== style.css .kill ===');
console.log(block(css, '.kill'));
console.log('=== style.css .backend 的 max-width ===');
const b = block(css, '.backend');
console.log((b.match(/max-width:[^;]+/) || ['(无)'])[0]);
console.log('=== style.css .jump 的 bottom ===');
const jm = block(css, '.jump');
console.log((jm.match(/bottom:[^;]+/) || ['(无)'])[0]);
console.log('=== index.html 的 kill 按钮 ===');
console.log((html.match(/<button id="kill"[\s\S]*?<\/button>/) || ['(没找到)'])[0]);
console.log('=== index.html 的版本号 ===');
console.log((html.match(/\?v=\d+/g) || []).join(' '));
console.log('=== app.js 是否含增量渲染 ===');
const app = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
console.log('splitBlocks:', /function splitBlocks\(/.test(app));
console.log('paintReplyInto:', /function paintReplyInto\(/.test(app));
console.log('paintReply 走增量:', /paintReplyInto\(currentBot\.querySelector/.test(app));

// 场景页是构建产物，内联了 web/ 的快照。截图前不重建，量到的就是
// 上一版样式 —— 而且每个数字都「看起来正常」（measure 里全是 PASS）。
// 写进同一个脚本，是为了让「看状态」和「确认产物不旧」变成同一个动作。
console.log('=== 构建产物新鲜度 ===');
const mtimes = {
  'scene-long.html': 'style.css',
  'scene-mixed.html': 'style.css',
  'scene-danger.html': 'style.css',
};
let stale = 0;
const cssM = fs.statSync(path.join(WEB, 'style.css')).mtimeMs;
const appM = fs.statSync(path.join(WEB, 'app.js')).mtimeMs;
const htmlM = fs.statSync(path.join(WEB, 'index.html')).mtimeMs;
for (const f of Object.keys(mtimes)) {
  const p = path.join(__dirname, f);
  if (!fs.existsSync(p)) { console.log('  ' + f + '  (不存在)'); continue; }
  const m = fs.statSync(p).mtimeMs;
  const worst = Math.max(cssM, appM, htmlM);
  const isStale = m < worst;
  if (isStale) stale++;
  console.log('  ' + f.padEnd(20) + (isStale ? '[过期] 比 web/ 旧，截图会量到上一版' : '[新鲜]'));
}
if (stale) {
  console.log('  → 先跑 node _mock/_bench/build-scene.js long|mixed|danger 再截图');
}
process.exit(stale ? 1 : 0);