#!/usr/bin/env node
// Verifies the Markdown renderer in web/app.js.
//
// The renderer is a pure function with no DOM access, so it is lifted out of the
// browser bundle and exercised here. This is not a convenience: the renderer is
// the one place in the UI that builds HTML out of model output, and a mistake in
// it shows up as either broken formatting or an injection. Both need a test that
// fails loudly instead of a screenshot that "looks fine".
//
// Zero dependencies, no network. Run: node tools\verify-md.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'web', 'app.js');
const source = fs.readFileSync(SRC, 'utf8');

// The renderer is delimited by its own banner comments so the extraction stays
// valid when unrelated code above or below it changes.
const START = 'function esc(s) {';
const END = '// ---- reply bubble';
const from = source.indexOf(START);
const to = source.indexOf(END);
if (from < 0 || to < 0 || to <= from) {
  console.error('FAIL  could not locate the renderer block in web/app.js');
  process.exit(1);
}
const block = source.slice(from, to);

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(`${block}\nthis.mdToHtml = mdToHtml; this.inlineMd = inlineMd; this.esc = esc;`, sandbox);
const { mdToHtml, inlineMd, esc } = sandbox;

let pass = 0;
const failures = [];

function is(actual, expected, name) {
  if (actual === expected) { pass++; return; }
  failures.push(`${name}\n      expected: ${expected}\n      actual:   ${actual}`);
}

function has(actual, needle, name) {
  if (String(actual).includes(needle)) { pass++; return; }
  failures.push(`${name}\n      expected to contain: ${needle}\n      actual: ${actual}`);
}

function hasNot(actual, needle, name) {
  if (!String(actual).includes(needle)) { pass++; return; }
  failures.push(`${name}\n      expected NOT to contain: ${needle}\n      actual: ${actual}`);
}

// ---- escaping --------------------------------------------------------------

is(esc('<script>'), '&lt;script&gt;', 'esc: angle brackets');
is(esc('a & b'), 'a &amp; b', 'esc: ampersand');
is(esc(`"'`), '&quot;&#39;', 'esc: both quote styles');

// ---- inline ----------------------------------------------------------------

is(inlineMd('**bold**'), '<strong>bold</strong>', 'inline: bold');
is(inlineMd('*em*'), '<em>em</em>', 'inline: italic');
is(inlineMd('`code`'), '<code>code</code>', 'inline: code span');
is(inlineMd('a `**x**` b'), 'a <code>**x**</code> b', 'inline: bold inside a code span stays literal');
has(inlineMd('**a** and **b**'), '<strong>a</strong> and <strong>b</strong>', 'inline: two bold runs');
// `2*3*4` is arithmetic, not emphasis: a word character before the opening `*`
// means there is no delimiter, so it must survive untouched.
is(inlineMd('2*3*4'), '2*3*4', 'inline: arithmetic asterisks are not italic');
is(inlineMd('计算 2*3*4 的值'), '计算 2*3*4 的值', 'inline: arithmetic inside a sentence is not italic');
is(inlineMd('这是 *强调* 吗'), '这是 <em>强调</em> 吗', 'inline: space-delimited italic still works');

has(inlineMd('[docs](https://example.com)'), '<a href="https://example.com"', 'inline: http link becomes an anchor');
has(inlineMd('[x](https://a.b)'), 'rel="noopener noreferrer"', 'inline: anchors get rel=noopener');
is(
  inlineMd('[x](javascript:alert(1))'),
  '[x](javascript:alert(1))',
  'inline: javascript: link is refused, left as text'
);
is(
  inlineMd('[x](data:text/html,<script>)'),
  '[x](data:text/html,&lt;script&gt;)',
  'inline: data: link is refused'
);

// ---- blocks ----------------------------------------------------------------

is(mdToHtml('# 标题'), '<h1>标题</h1>', 'block: h1');
is(mdToHtml('### 小标题'), '<h3>小标题</h3>', 'block: h3');
is(mdToHtml('- 甲\n- 乙'), '<ul><li>甲</li><li>乙</li></ul>', 'block: unordered list');
is(mdToHtml('1. 甲\n2. 乙'), '<ol><li>甲</li><li>乙</li></ol>', 'block: ordered list');
is(mdToHtml('---'), '<hr>', 'block: horizontal rule');
has(mdToHtml('> 引用'), '<blockquote>', 'block: blockquote');
is(mdToHtml('第一段\n\n第二段'), '<p>第一段</p><p>第二段</p>', 'block: two paragraphs');

// Chat replies hard-wrap their own lines; a single newline must stay visible
// instead of being collapsed into one run-on paragraph.
has(mdToHtml('第一行\n第二行'), '第一行<br>第二行', 'block: single newline becomes a <br>');

is(mdToHtml('```js\nconst a = 1;\n```'), '<pre><code data-lang="js">const a = 1;</code></pre>', 'block: fenced code with language');
is(mdToHtml('```\nplain\n```'), '<pre><code>plain</code></pre>', 'block: fence without a language');
has(mdToHtml('```\n**not bold**\n```'), '**not bold**', 'block: markdown inside a fence stays literal');
has(mdToHtml('```\n<b>x</b>\n```'), '&lt;b&gt;x&lt;/b&gt;', 'block: HTML inside a fence is escaped');

// A reply that is still streaming has an opening fence and nothing else. It must
// not throw and must not swallow the rest of the buffer.
const streaming = mdToHtml('前言\n```py\nprint(1)');
has(streaming, '<pre><code data-lang="py">print(1)</code></pre>', 'block: unterminated fence still renders');
has(streaming, '前言', 'block: text before an unterminated fence survives');

// ---- the reason this file exists -------------------------------------------

const injection = mdToHtml('正常文本\n\n<img src=x onerror="alert(1)">\n\n**粗**');
hasNot(injection, '<img', 'security: injected <img> is escaped');
hasNot(injection, 'onerror="alert(1)"', 'security: inline event handler never survives as an attribute');
has(injection, '<strong>粗</strong>', 'security: escaping does not break normal rendering');

hasNot(mdToHtml('<script>alert(1)</script>'), '<script>', 'security: script tag is escaped');

// ---- report ----------------------------------------------------------------

const total = pass + failures.length;
if (failures.length) {
  console.log(`verify-md: ${pass}/${total} passed, ${failures.length} FAILED\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}) ${f}\n`));
  process.exit(1);
}
console.log(`verify-md: ${pass}/${total} passed`);
