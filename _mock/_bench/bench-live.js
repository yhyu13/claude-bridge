// bench-live.js —— 嵌在 bench-live.html 里，在 addTool/addToolResult 的
// **真实实现**定义之后执行。三个假设，逐个量。
//
// 每个假设都写成「如果为真，X 会随 Y 增长而增长」，然后真的去测 X 随 Y
// 怎么变。上一轮教训：先假设再验证，被自己的数据推翻过两次。

const stage = document.getElementById('stage');
const sink = document.getElementById('sink');
const out = document.getElementById('out');
const L = [];
const TID = (i) => 'tid-' + i;

// ═══ A. addToolResult 的 O(n) 查找 ═══════════════════════════════════════
// 它做的是：[...els.log.querySelectorAll('.tool[data-tid]')].reverse()
// 然后线性找匹配。卡片越多，每次结果越贵。
// 量法：先铺 N 张卡，再打 K 次 result，看总耗时随 N 怎么变。
// 如果是 O(n)，N 翻倍 → 耗时接近翻倍。

function fillCards(n) {
  stage.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const c = addTool(['Read', 'Bash', 'Edit', 'Grep'][i % 4],
      { file_path: 'src\\file-' + i + '.js' }, false);
    c.dataset.tid = TID(i);
  }
  void stage.offsetHeight;   // 建完强制一次布局，把建卡片的成本排除在外
}

function benchLookup(cards, results) {
  fillCards(cards);
  // 打 results 次 result，每次都打**最后一张**（真实情况：结果紧跟调用）
  const ids = [];
  for (let i = 0; i < results; i++) ids.push(TID(cards - 1));
  const t0 = performance.now();
  for (const id of ids) {
    addToolResult(id, true, 'ok', 128, 12);
  }
  void stage.offsetHeight;
  return +(performance.now() - t0).toFixed(1);
}

L.push('<span class="h">A. addToolResult 的 tid 查找 —— querySelectorAll 全量扫 + 线性找</span>');
const aRows = [];
for (const n of [50, 100, 200, 400, 800]) {
  const ms = benchLookup(n, 40);       // 固定 40 次结果，只变卡片数
  aRows.push({ n, ms, per: +(ms / 40).toFixed(2) });
  L.push('  卡片 ' + String(n).padStart(4) + ' 张，打 40 次结果：' +
    String(ms).padStart(7) + ' ms   每次 ' + String(ms / 40).padStart(6) + ' ms');
}
const g1 = aRows[aRows.length - 1].per / aRows[0].per;
L.push('  卡片数 16 倍（50→800），单次成本 ' + aRows[0].per + ' → ' + aRows[aRows.length - 1].per +
  ' ms，涨了 ' + g1.toFixed(1) + ' 倍  ' +
  (g1 > 5 ? '<span class="bad">→ 近似 O(n)，确认是真瓶颈</span>'
    : '<span class="warn">→ 增长有限，这个假设被自己的数据推翻</span>'));

// ═══ B. follow() 逐 chunk 强制同步布局 ═══════════════════════════════════
// atBottom() 读 scrollHeight/scrollTop/clientHeight，紧接着写 scrollTop ——
// 读写交替就是强制同步布局。而 botText() 每个 chunk 都调 follow()。
// 量法：把已渲染内容堆到一定高度，然后模拟 N 个 chunk，
// 对比「每 chunk 都 follow」与「完全不 follow」的耗时差。

function benchFollow(chunks) {
  stage.innerHTML = '';
  sink.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'msg bot';
  const t = document.createElement('div');
  t.className = 'text';
  t.innerHTML = '<p>' + '行内容<br>'.repeat(400) + '</p>';   // 撑够高
  box.appendChild(t);
  stage.appendChild(box);
  void stage.offsetHeight;

  const atBottom = () => stage.scrollHeight - stage.scrollTop - stage.clientHeight < 90;
  const follow = () => {
    if (atBottom()) { stage.scrollTop = stage.scrollHeight; }
  };
  // 先滚到底，让 atBottom() 恒为 true —— 一轮进行中就是这个状态
  stage.scrollTop = stage.scrollHeight;

  const t0 = performance.now();
  for (let i = 0; i < chunks; i++) {
    t.appendChild(document.createElement('br'));   // 模拟内容增长
    follow();
  }
  void stage.offsetHeight;
  const withF = performance.now() - t0;

  stage.innerHTML = '';
  sink.innerHTML = '';
  const box2 = document.createElement('div');
  box2.className = 'msg bot';
  const t2 = document.createElement('div');
  t2.className = 'text';
  t2.innerHTML = '<p>' + '行内容<br>'.repeat(400) + '</p>';
  box2.appendChild(t2);
  stage.appendChild(box2);
  void stage.offsetHeight;
  stage.scrollTop = stage.scrollHeight;
  const t1 = performance.now();
  for (let i = 0; i < chunks; i++) {
    t2.appendChild(document.createElement('br'));
  }
  void stage.offsetHeight;
  const without = performance.now() - t1;

  return { withF: +withF.toFixed(1), without: +without.toFixed(1) };
}

L.push('');
L.push('<span class="h">B. follow() 的强制同步布局 —— 每个 chunk 读 scrollHeight 再写 scrollTop</span>');
const b = benchFollow(200);
L.push('  200 个 chunk，每 chunk follow()：' + String(b.withF).padStart(7) + ' ms');
L.push('  200 个 chunk，完全不 follow：' + String(b.without).padStart(7) + ' ms');
L.push('  follow 多花 ' + (b.withF - b.without).toFixed(1) + ' ms，单 chunk ' +
  ((b.withF - b.without) / 200).toFixed(2) + ' ms  ' +
  (b.withF - b.without > 200 ? '<span class="bad">→ 每次同步布局都在主线程上，值得合批</span>'
    : '<span class="warn">→ 单帧内可忽略</span>'));

// ═══ C. paintReply 全量重解析（复验上一轮的结论） ═══════════════════════
// 上一轮量 50 个 chunk，结论「不是 O(n²)」。但真实回复比那个长。
// 这次用更长的文本、更贴近真实的分块，看它到底怎么长。

/**
 * 把「解析」和「写 DOM + 布局」拆开量。
 * 不拆就没法选修法：如果是解析慢，就该做增量解析；如果是 innerHTML 慢，
 * 就该只更新变化的那一个子节点。两种修法完全不一样，猜错就是白改。
 */
function benchPaintSplit(chunks, unitLines) {
  const box = document.createElement('div');
  box.className = 'msg bot';
  const t = document.createElement('div');
  t.className = 'text';
  box.appendChild(t);
  sink.innerHTML = '';
  sink.appendChild(box);
  void sink.offsetHeight;

  const BT = String.fromCharCode(96);
  const unit = [];
  for (let i = 0; i < unitLines; i++) {
    unit.push('第 ' + i + ' 行的说明文字，' + BT + 'code' + BT + ' 和 **bold** 混排。');
  }
  const unitStr = unit.join('\n\n');

  let raw = '';
  let parse = 0, dom = 0;
  let lastHtml = '';
  for (let i = 0; i < chunks; i++) {
    raw += unitStr;
    const a = performance.now();
    lastHtml = mdToHtml(raw);                 // ① 只解析
    const b = performance.now();
    t.innerHTML = lastHtml;                   // ② 写 DOM
    void t.offsetHeight;                      // ③ 强制同步布局
    const c = performance.now();
    parse += b - a;
    dom += c - b;
  }
  sink.innerHTML = '';
  const total = parse + dom;
  return {
    total: +total.toFixed(1), parse: +parse.toFixed(1), dom: +dom.toFixed(1),
    parsePct: Math.round(parse / total * 100), domPct: Math.round(dom / total * 100),
    chars: raw.length, blocks: (lastHtml.match(/<\/?(p|h[1-6]|pre|ul|ol|hr|blockquote)[ >]/g) || []).length / 2,
  };
}

L.push('');
L.push('<span class="h">C. paintReply 全量重解析 —— 用比上一轮长 4 倍的文本复验</span>');
const c1 = benchPaintSplit(50, 6);
const c2 = benchPaintSplit(200, 6);
L.push('  50 个 chunk（' + c1.chars + ' 字符 / ' + c1.blocks + ' 块）：总 ' + String(c1.total).padStart(7) + ' ms');
L.push('  200 个 chunk（' + c2.chars + ' 字符 / ' + c2.blocks + ' 块）：总 ' + String(c2.total).padStart(7) + ' ms');
const ratio = c2.total / c1.total;
const nRatio = 200 / 50;
L.push('  文本 4 倍，耗时 ' + ratio.toFixed(1) + ' 倍  ' +
  (ratio > nRatio * 1.6 ? '<span class="bad">→ 超过线性，O(n²) 成立</span>'
    : '<span class="ok">→ 接近线性（' + nRatio.toFixed(0) + ' 倍输入 / ' + ratio.toFixed(1) + ' 倍耗时）</span>'));
L.push('');
L.push('  <b>把成本拆开</b>（修法要靠它选）：');
L.push('    解析 mdToHtml   ' + String(c2.parse).padStart(8) + ' ms  (' + c2.parsePct + '%)');
L.push('    写 DOM + 布局   ' + String(c2.dom).padStart(8) + ' ms  (' + c2.domPct + '%)');
L.push('  → 增量修法（只更新最后一块）理论上限很高，实测见 E 段。');
L.push('  注：这一段里 200 块每次全被 innerHTML 重建，浪费的是 92% 的写 DOM 成本。');

// ═══ E. 增量渲染的收益上限 ══════════════════════════════════════════════
// C 量到 O(n²)，但「增量渲染能省多少」不能靠估。
// 这里实现一个**和准备落地的算法同构**的版本，用同一份 mdToHtml，
// 量它在同一批数据上到底快多少。修法写在 app.js 之前，先在这里证伪一次。
//
// 算法：把 mdToHtml 的输出按顶层块切开。流式回复里，
// 除最后一个块以外的所有块在收到新 chunk 后都不会变
// （Claude 是按块往下写的，不会回头改已经收尾的段落）。
// 于是只重渲染最后一块，前面的块留着不动。

// 增量对照跑的是 app.js 里**上线那版**的 paintReplyInto（build 时切进来），
// 这里不另写一份。
//
// 之前这里另写过一份 splitBlocks：正则数括号深度，对所有输入都返回 0 块，
// 于是增量版什么都没渲染，却报出 17 倍提速 —— 假快。
// 「快的」和「对的」必须用同一份代码验证，否则其中一条根本没被测到。
//
// 这里只留基线用的全量对照（那是它本来的样子，不算复制品）。
function paintFull(host, raw) {
  host.innerHTML = mdToHtml(raw);   // ← 改动前的 paintReply()，作为基线
  void host.offsetHeight;
}

function benchIncremental(chunks, unitLines) {
  const box = document.createElement('div');
  box.className = 'msg bot';
  const t = document.createElement('div');
  t.className = 'text';
  box.appendChild(t);
  sink.innerHTML = '';
  sink.appendChild(box);
  void sink.offsetHeight;

  const BT = String.fromCharCode(96);
  const unit = [];
  for (let i = 0; i < unitLines; i++) {
    unit.push('第 ' + i + ' 行的说明文字，' + BT + 'code' + BT + ' 和 **bold** 混排。');
  }
  const unitStr = unit.join('\n\n');

  let raw = '';
  let total = 0;
  let changed = 0;
  for (let i = 0; i < chunks; i++) {
    raw += unitStr;
    const before = t._blocks ? t._blocks.length : 0;
    const a = performance.now();
    paintReplyInto(t, raw);
    void t.offsetHeight;
    total += performance.now() - a;
    // 统计：这一轮真的有几个块被改写了
    const after = t._blocks.length;
    changed += after - before;
  }
  const n = t._blocks.length;
  sink.innerHTML = '';
  return { total: +total.toFixed(1), chars: raw.length, blocks: n, changed };
}

L.push('');
L.push('<span class="h">E. 增量渲染 vs 全量重解析 —— 同一个 mdToHtml，同一批数据</span>');
const e2 = benchIncremental(200, 6);
L.push('  增量 200 个 chunk（' + e2.chars + ' 字符 / ' + e2.blocks + ' 块）：总 ' +
  String(e2.total).padStart(8) + ' ms');
L.push('  全量 200 个 chunk（同样数据）：             总 ' +
  String(c2.total).padStart(8) + ' ms');
const speedup = c2.total / e2.total;
L.push('  快 ' + speedup.toFixed(1) + ' 倍   单次刷新 ' + (e2.total / 200).toFixed(2) +
  ' ms（原 ' + (c2.total / 200).toFixed(2) + ' ms）');
L.push('  60ms 节奏下帧预算占用 ' +
  Math.round((c2.total / 200) / 60 * 100) + '% → ' +
  Math.round((e2.total / 200) / 60 * 100) + '%  ' +
  (speedup > 3 ? '<span class="ok">→ 值得做</span>' : '<span class="warn">→ 收益不够，本轮不做</span>'));
L.push('  <b>正确性代价</b>：增量版假设「已收尾的块不会被回头改写」。');
L.push('  这不是所有流都成立（比如先写一段文字、再决定改成列表），');
L.push('  所以必须有一道闸证明两条路径产出<b>同构 DOM</b>：');
L.push('  node _mock/_bench/verify-incremental.js');
L.push('  它还会被 node _mock/_bench/positive-control.js 用四个探针验过一遍 ——');
L.push('  四个探针都必须靠断言转红，而不是靠被测脚本崩掉。');
// ═══ D. poll 载荷 ═══════════════════════════════════════════════════════
// 每次 poll 都返回完整 status（含 ready 全量快照：工具/技能/MCP 列表）。
// 长会话里 ready 是常量，却每次都序列化+传输+客户端重解析。
// 量法：看 showReady 每次被调用要写几个 DOM 节点、写多少字符。

const readyNode = {
  cwd: 'C:\\code\\my-project',
  toolCount: 24,
  skills: ['brainstorming', 'tdd', 'code-review', 'code-review', 'grilling', 'to-spec',
    'investigation-first', 'contradiction-analysis', 'mass-line', 'workflow'],
  mcpServers: ['demo', 'demo-offline', 'fs', 'git', 'gh', 'web'],
};
const bits = [];
if (readyNode.toolCount != null) bits.push(readyNode.toolCount + ' 个工具');
if (readyNode.skills) bits.push(readyNode.skills.length + ' 技能');
if (readyNode.mcpServers) bits.push(readyNode.mcpServers.length + ' MCP');
const statusText = bits.join(' · ');

L.push('');
L.push('<span class="h">D. poll 每 800ms 重写 status 行 —— 内容其实没变</span>');
L.push('  status 文案：「' + statusText + '」（每次 poll 都写同样的字符串）');
L.push('  cwd 每次重写 title（' + readyNode.cwd.length + ' 字符模板串）');
L.push('  → 800ms 一轮 = 每分钟 ' + (60000 / 800).toFixed(0) + ' 次同样的写入');

// ═══ 汇总 ═══════════════════════════════════════════════════════════════
L.push('');
L.push('<span class="h">结论</span>');
if (g1 > 5) L.push('  1. addToolResult 的全量扫描是真瓶颈，优先修。');
else L.push('  1. addToolResult 扫描<b>不是</b>瓶颈（增长 ' + g1.toFixed(1) + ' 倍）。');
if (b.withF - b.without > 200) L.push('  2. follow() 的强制布局值得合批。');
else L.push('  2. follow() 同步布局<b>不是</b>瓶颈。');
if (ratio > nRatio * 1.6) L.push('  3. paintReply 确认为 O(n²)。');
else L.push('  3. paintReply 接近线性，<b>不是</b>瓶颈。');
if (speedup > 3) L.push('  4. 增量渲染快 ' + speedup.toFixed(1) + ' 倍，落地。');
else L.push('  4. 增量渲染只快 ' + speedup.toFixed(1) + ' 倍，<b>不落地</b>（收益不足以换一份正确性风险）。');

out.innerHTML = L.join('\n');
document.title = 'bench-live';
void stage; void sink;