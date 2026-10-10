// narrow-diag.js — 由 build-narrow.js 嵌入。页面自己算出溢出量并打印。
const out = document.getElementById('diag');
const stage = document.getElementById('stage');
const rows = [];

function w(el) { return +el.getBoundingClientRect().width.toFixed(1); }

// 1) 整页有没有横向溢出
const pageOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;

// 2) 逐条 ribbon：自身是否溢出，以及每个子元素的宽度和 flex-shrink
document.querySelectorAll('.ribbon').forEach((r, idx) => {
  const kids = [...r.children].map((c) => ({
    n: (c.className || c.tagName.toLowerCase()).toString().slice(0, 12),
    px: w(c),
    shrink: getComputedStyle(c).flexShrink,
    basis: getComputedStyle(c).flexBasis,
  }));
  const inner = r.querySelector('.rib-in');
  const fixedKids = kids.filter((k) => k.shrink === '0');
  rows.push({
    i: idx,
    cardW: w(r),
    scrollW: r.scrollWidth,
    clientW: r.clientWidth,
    over: r.scrollWidth - r.clientWidth,
    fixedTotal: +fixedKids.reduce((a, k) => a + k.px, 0).toFixed(1),
    kids,
  });
});

// 3) composer / topbar 也看一眼
const other = ['.topbar', '.composer', '.prose', '.you'].map((sel) => {
  const e = document.querySelector(sel);
  if (!e) return null;
  return { sel, px: w(e), over: e.scrollWidth - e.clientWidth };
}).filter(Boolean);

let html = '<b>舞台宽 ' + w(stage) + 'px ｜ 整页横向溢出 ' + pageOverflow + 'px</b>\n\n';
html += '<b>每条 ribbon</b>\n\n';
for (const r of rows) {
  const bad = r.over > 0;
  html += (bad ? '<span class="bad">溢出 ' + r.over + 'px</span>' : '<span class="ok">正常</span>')
    + '  #' + r.i + '  卡片 ' + r.cardW + 'px  scrollW ' + r.scrollW + '  clientW ' + r.clientW
    + '  不收缩的子元素合计 ' + r.fixedTotal + 'px\n';
  for (const k of r.kids) {
    html += '        ' + k.n.padEnd(12) + String(k.px).padStart(7) + 'px  shrink:' + k.shrink + '  basis:' + k.basis + '\n';
  }
  html += '\n';
}
html += '<b>其他块</b>\n\n';
for (const o of other) {
  html += (o.over > 0 ? '<span class="bad">溢出 ' + o.over + 'px</span>' : '<span class="ok">正常</span>')
    + '  ' + o.sel.padEnd(10) + o.px + 'px\n';
}
out.innerHTML = html;