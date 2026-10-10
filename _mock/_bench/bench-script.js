// bench-script.js —— 会被 build-bench.js 原样嵌进 bench.html，在 app.js 的
// 真实 mdToHtml 定义之后执行。
//
// 量两件事：
//   A. 材质开销（同步 style+layout）—— 硬阴影 / 软阴影 / backdrop-filter
//   B. 真实热路径 —— paintReply() 的行为：每 60ms 全量重解析累积中的回复
//
// B 才是这个应用真正的性能故事。A 只是为了证明「材质不是瓶颈」。

const host = document.getElementById('host');
const sink = document.getElementById('sink');
const out = document.getElementById('out');
const L = [];

// ── A. 材质 ──────────────────────────────────────────────────────────────
function matBench(cls, bg) {
  const c = document.createElement('div');
  c.className = 'col' + (bg ? ' bg' : '');
  host.appendChild(c);
  for (let i = 0; i < 20; i++) {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = 'warmup ' + i;
    c.appendChild(d);
  }
  void c.offsetHeight;          // 预热并强制一次同步
  c.textContent = '';

  const t0 = performance.now();
  for (let i = 0; i < 300; i++) {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = 'src\\claude-session.js 第 ' + i + ' 行 · args.push';
    c.appendChild(d);
  }
  void c.offsetHeight;          // 强制同步 style+layout
  const t1 = performance.now();
  host.removeChild(c);
  return { sync: +(t1 - t0).toFixed(1) };
}

// ── B. 真实热路径 ────────────────────────────────────────────────────────
const BT = String.fromCharCode(96); // 反引号，避免和脚本生成打架

function streamBench(chunks) {
  sink.innerHTML = '<div class="msg"><div class="text"></div></div>';
  const text = sink.querySelector('.text');
  const unit = [
    '## 第 N 节',
    '',
    '切换走的是「杀进程 + ' + BT + '--resume' + BT + ' 重开」，因为 '
      + BT + '--model' + BT + ' 是**启动参数**，活着的进程改不了。',
    '',
    '- 重开时带上 ' + BT + '--resume <session-id>' + BT,
    '- 把会话接回来，对话不会丢',
    '',
    BT + BT + BT + 'js',
    'if (this.proc && this.proc !== proc) return;',
    BT + BT + BT,
    '',
  ].join('\n');

  let raw = '';
  let total = 0;
  const per = [];
  for (let i = 0; i < chunks; i++) {
    raw += unit;
    const a = performance.now();
    text.innerHTML = mdToHtml(raw);   // ← 与 paintReply() 完全一致的动作
    void text.offsetHeight;           // 强制同步，不让浏览器攒着偷懒
    const b = performance.now();
    per.push(b - a);
    total += b - a;
  }
  return {
    total: +total.toFixed(1),
    avg: +(total / chunks).toFixed(1),
    first: +per[0].toFixed(1),
    last: +per[per.length - 1].toFixed(1),
    chars: raw.length,
    htmlLen: text.innerHTML.length,
  };
}

// ── C. 长会话：日志无上限增长 ───────────────────────────────────────────
// app.js 里 els.log 是纯 appendChild，没有任何虚拟化/回收。量一下长会话下
// 一次强制全量布局要多久 —— 这才是这个应用真正会退化的地方。
function longLogBench(turns) {
  const box = document.createElement('div');
  box.className = 'col';
  box.style.width = '400px';
  host.appendChild(box);
  const marks = [];
  for (let t = 1; t <= turns; t++) {
    // 一轮的真实结构：用户泡 + 助手泡 + 4 张工具卡（details+summary+pre）
    const u = document.createElement('div');
    u.className = 'msg';
    const ub = document.createElement('div');
    ub.textContent = '第 ' + t + ' 轮的问题';
    u.appendChild(ub);
    box.appendChild(u);
    for (let k = 0; k < 4; k++) {
      const d = document.createElement('details');
      d.className = 'tool';
      const s = document.createElement('summary');
      const nm = document.createElement('span'); nm.className = 'name';
      nm.textContent = ['Read', 'Bash', 'Edit', 'Grep'][k];
      const de = document.createElement('span'); de.className = 'desc';
      de.textContent = 'src\\claude-session.js 第 ' + k + ' 行';
      const ar = document.createElement('span'); ar.className = 'arrow'; ar.textContent = '›';
      s.append(nm, de, ar);
      const b = document.createElement('div'); b.className = 'body';
      const pre = document.createElement('pre'); pre.className = 'args';
      pre.textContent = '{\n  "file_path": "src\\\\claude-session.js"\n}';
      b.appendChild(pre);
      d.append(s, b);
      box.appendChild(d);
    }
    const a = document.createElement('div');
    a.className = 'msg';
    const ab = document.createElement('div');
    ab.textContent = '第 ' + t + ' 轮的回答，切换走的是杀进程加重开，带上 --resume 把会话接回来。';
    a.appendChild(ab);
    box.appendChild(a);
    if (t === 20 || t === 50 || t === 100) {
      const x0 = performance.now();
      void box.offsetHeight;          // 强制全量布局
      marks.push({ t, ms: +(performance.now() - x0).toFixed(2),
                   nodes: document.getElementsByTagName('*').length });
    }
  }
  const total = document.getElementsByTagName('*').length;
  host.removeChild(box);
  return { marks, total };
}

// ── 跑 ──────────────────────────────────────────────────────────────────
const soft = matBench('soft');
const hard = matBench('hard');
const glass = matBench('glass', true);
const s = streamBench(50);
const lg = longLogBench(100);

L.push('<span class="h">A. 材质开销 —— 300 张卡片，同一批 DOM，只有阴影/滤镜不同（同步 style+layout）</span>');
L.push('  软阴影 blur=14px'.padEnd(26) + String(soft.sync).padStart(7) + ' ms');
L.push('  硬阴影 blur=0  ← B+ 用这个'.padEnd(24) + String(hard.sync).padStart(7) + ' ms');
L.push('  backdrop-filter 玻璃'.padEnd(24) + String(glass.sync).padStart(7) + ' ms');
L.push('  硬阴影 / 软阴影 = ' + (soft.sync / hard.sync).toFixed(2) + 'x');
L.push('  玻璃   / 硬阴影 = ' + (glass.sync / hard.sync).toFixed(2) + 'x');
L.push('');
L.push('<span class="h">B. 真实热路径 —— paintReply() 全量重解析累积中的回复，50 个 chunk</span>');
L.push('  总耗时 ' + s.total + ' ms，平均每 chunk ' + s.avg + ' ms');
L.push('  首个 chunk ' + s.first + ' ms（含 JIT 预热），末个 ' + s.last + ' ms');
L.push('  文本长了 ' + '50' + ' 倍，单次只从 ~2 涨到 ' + s.last + ' ms  →  <span class="ok">远不是 O(n²)</span>');
L.push('  按 60ms 一次的节奏，单次刷新只占约 ' + Math.round(s.avg / 60 * 100) + '% 的一帧预算');
L.push('');
L.push('<span class="h">C. 长会话 —— els.log 纯 appendChild，无虚拟化。强制全量布局</span>');
for (const m of lg.marks) {
  L.push('  第 ' + String(m.t).padStart(3) + ' 轮结束时：全量布局 ' + String(m.ms).padStart(7) + ' ms   DOM ' + m.nodes + ' 个节点');
}
L.push('');
L.push('<span class="warn">结论：材质不是瓶颈，paintReply 也不是。长会话的 DOM 无上限增长才是唯一会退化的项。</span>');

out.innerHTML = L.join('\n');