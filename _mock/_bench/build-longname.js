#!/usr/bin/env node
'use strict';
/**
 * build-longname.js — 量一个具体的窄屏隐患：工具名太长时路径会不会被挤没。
 *
 * 为什么量这个而不是量「散不散架」：320px 下实测整页横向溢出 0px、
 * 每条 ribbon scrollW == clientW，**没有散架**。真正会坏的是另一件事——
 * `.rib-n`（工具名）是 flex:0 0 auto 且不截断，MCP 工具名动辄 20+ 字符，
 * 它会把 `.rib-p`（路径，唯一能缩的）挤到 0 宽，于是**路径整个消失**，
 * 但因为 .ribbon 有 overflow:hidden，页面看不出报错，只是"看不见传了哪个文件"。
 *
 * 输入：06-brutalist-signals.html 原文
 * 输出：longname-<宽>-<标签>.html，两组内容（普通名 / 超长名）并排，方便对照
 */

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const demo = fs.readFileSync(path.join(HERE, '..', '06-brutalist-signals.html'), 'utf8');
const css = demo.match(/<style>([\s\S]*?)<\/style>/)[1];

function sliceBalanced(src, openRe) {
  const start = src.search(openRe);
  if (start < 0) throw new Error('找不到 ' + openRe);
  const tagRe = /<(\/?)div\b[^>]*?(\/?)>/g;
  tagRe.lastIndex = start;
  let depth = 0, m;
  while ((m = tagRe.exec(src))) {
    if (m[2] === '/') continue;
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return src.slice(start, m.index + m[0].length);
  }
  throw new Error('没配对上');
}

// mcp__demo__ 是 scan-secrets.js 给 fixture 预留的豁免前缀，见 build-live.js 里的说明。
const LONG = 'mcp__demo__knowledge_base_search_documents';
const widths = [320, 390];
const made = [];

for (const W of widths) {
  for (const [tag, name] of [['short', 'Bash'], ['long', LONG]]) {
    // 从原文切出 .phone，改掉第一条 ribbon 的工具名，其余原样
    let phone = sliceBalanced(demo, /<div class="phone">/);
    const first = phone.search(/<span class="rib-n">[^<]*<\/span>/);
    if (first < 0) throw new Error('没找到 .rib-n');
    phone = phone.replace(/(<span class="rib-n">)[^<]*(<\/span>)/, '$1' + name + '$2');

    const js = [
      'const rows=[];',
      'document.querySelectorAll(".ribbon").forEach((r,i)=>{',
      ' const n=r.querySelector(".rib-n"), p=r.querySelector(".rib-p");',
      ' const t=r.querySelector(".rib-t"), c=r.querySelector(".rib-c");',
      ' const g=(e)=>e?+e.getBoundingClientRect().width.toFixed(1):0;',
      ' rows.push({i, over:r.scrollWidth-r.clientWidth, n:g(n), p:g(p), t:g(t), c:g(c),',
      '  vis:p?p.getBoundingClientRect().width>0:false,',
      '  txt:p?(p.scrollWidth>p.clientWidth?"截断":"完整"):"-"});',
      '});',
      'let h="舞台 '+W+'px ｜ 工具名 <b>'+tag+'</b>（'+name.length+' 字符）\\n\\n";',
      'for(const r of rows){h+=(r.over>0?"<span class=bad>溢出"+r.over+"px</span>":"<span class=ok>正常</span>")',
      ' +"  ribbon#"+r.i+"  名 "+r.n+"px  路径 "+r.p+"px"+(!r.vis?"  <span class=bad>路径宽度 0（看不见）</span>":"")',
      ' +"  耗时 "+r.t+"px  符号 "+r.c+"px  路径"+r.txt+"\\n";}',
      'document.getElementById("diag").innerHTML=h;',
    ].join('\n');

    const html = [
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>longname ' + W + ' ' + tag + '</title>',
      '<style>', css,
      'body{margin:0;background:#222}',
      '#diag{background:#000;color:#5fd39a;font:12px/1.55 Consolas,monospace;padding:12px 16px;white-space:pre}',
      '#stage{width:' + W + 'px;padding:0 8px 20px;background:#F4EFE4}',
      '#stage .phone{height:auto;max-width:none}',
      '.bad{color:#ff6b6b}.ok{color:#5fd39a}',
      '</style></head><body>',
      '<pre id="diag">measuring…</pre>',
      '<div id="stage">', phone, '</div>',
      '<script>', js, '</script>',
      '</body></html>',
    ].join('\n');

    const name2 = 'longname-' + W + '-' + tag + '.html';
    fs.writeFileSync(path.join(HERE, name2), html, 'utf8');
    made.push(name2);
  }
}

console.log('已生成: ' + made.join(', '));
console.log('工具名 ' + LONG.length + ' 字符，MCP 常见长度');
