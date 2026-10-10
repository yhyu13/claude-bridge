'use strict';
// 一次性工具：列出 web/app.js 与 web/index.html 里出现的所有 class/id，
// 用来保证重写 style.css 时不会漏掉任何一个（漏一个 = 线上静默失效的样式）。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', 'web');
const files = ['app.js', 'index.html'].map((f) => path.join(root, f));
const classes = new Set();
const ids = new Set();

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/className\s*=\s*'([^']*)'/g)) {
    for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  }
  for (const m of src.matchAll(/className\s*=\s*"([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  }
  for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\('([^']+)'/g)) classes.add(m[1]);
  for (const m of src.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  }
  for (const m of src.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
  for (const m of src.matchAll(/els\.\w+\s*=\s*\$\('([^']+)'\)/g)) ids.add(m[1]);
  for (const m of src.matchAll(/getElementById\('([^']+)'\)/g)) ids.add(m[1]);
}

const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const missingCls = [...classes].filter((c) => !css.includes('.' + c)).sort();
const missingId = [...ids].filter((c) => !css.includes('#' + c)).sort();

console.log('app.js/index.html 用到的 class (' + classes.size + '):');
console.log('  ' + [...classes].sort().join('  '));
console.log('\nid (' + ids.size + '):');
console.log('  ' + [...ids].sort().join('  '));
console.log('\nstyle.css 里没有对应规则的 class: ' + (missingCls.length ? missingCls.join(', ') : '（无）'));
console.log('style.css 里没有对应规则的 id: ' + (missingId.length ? missingId.join(', ') : '（无）'));
if (missingCls.length || missingId.length) process.exit(1);
