#!/usr/bin/env node
'use strict';
/**
 * scrub-fixture.js — 把真实抓下来的协议样本洗成可以公开进仓库的样本。
 *
 * 为什么需要它
 * ------------
 * `claude -p --output-format stream-json` 吐出来的那条 init 事件里，带着一整套
 * 这台机器的指纹：
 *
 *   - Windows / macOS 用户名（memory_paths、tool 里的绝对路径）
 *   - 工程目录和项目名
 *   - MCP 服务器清单，以及每个 server 展开出来的几十个工具名
 *     （实测抓到 5 个 server / 60 个工具，其中包含工作单位的内部平台）
 *   - 完整的个人 skill 库和 slash 命令表（实测 129 / 163 条）
 *   - 真实 session_id 和 uuid —— 可以和其他日志关联回这台机器
 *   - 正在用的模型名、命名管道路径
 *
 * 原样提交到公开仓库，等于告诉所有人：这个人用什么模型、装了哪些集成、
 * 在哪个公司做什么项目。所以抓包样本必须洗过才能进仓库。
 *
 * 洗的时候保留什么（这些是测试价值本身，洗掉就白抓了）
 *   - 事件顺序与事件类型 —— translator 的行为完全依赖它
 *   - tool_use id 之间的对应关系 —— tool_result 配对逻辑依赖它
 *   - 成本与 token 数字 —— verify-translator.js 的累计/差分断言就钉在这些数上
 *   - 正文文本（只替换其中的路径，句子结构保留）
 *
 * 用法
 *   node tools\scrub-fixture.js <in.ndjson> <out.ndjson>   洗一份新的
 *   node tools\scrub-fixture.js --in-place <file> [...]     原地洗，可重复执行
 *   node tools\scrub-fixture.js --check <file> [...]        只体检，不改文件
 *
 * --check 是真正的价值所在：它被挂进 npm run verify，于是「抓了新样本忘得洗」
 * 会在提交前被挡住，而不是等到仓库公开之后。
 */

const fs = require('fs');
const path = require('path');

// ── 本机补充规则 ────────────────────────────────────────────────────────────
// 通用规则只能覆盖"任何机器都成立"的形态：家目录、Desktop、UUID、tool_use id、
// Claude Code 的目录 slug。
//
// 本机特有的项目名、用户名、集成名、中转域名**不能写死在这里**——那等于把要
// 藏的东西直接印在源码里，工具自己就成了泄露源。它们从仓库根目录的
// `.scrub-denylist.json` 读，那个文件是 gitignore 的。
const LOCAL_DENYLIST = path.join(__dirname, '..', '.scrub-denylist.json');

function loadLocalRules() {
  const strings = [];
  const paths = [];
  if (!fs.existsSync(LOCAL_DENYLIST)) return { strings, paths };

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(LOCAL_DENYLIST, 'utf8'));
  } catch (e) {
    console.error(`! ${path.basename(LOCAL_DENYLIST)} 解析失败，已忽略：${e.message}`);
    return { strings, paths };
  }
  for (const s of cfg.strings || []) {
    if (typeof s === 'string' && s) strings.push(s);
  }
  for (const [from, to] of Object.entries(cfg.paths || {})) {
    if (from && to) paths.push([new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), to]);
  }
  return { strings, paths };
}

const LOCAL = loadLocalRules();

// ── 替换目标 ────────────────────────────────────────────────────────────────
const PROJECT_DIR = 'C:\\work\\project';        // 洗后的工程目录
const DEMO_MODEL = 'claude-sonnet-4-5';         // 洗后的模型名
const DEMO_PIPE = '\\\\.\\pipe\\LOCAL\\scrubbed';
const DEMO_MCP_SERVERS = [
  { name: 'demo', status: 'connected', source: 'user' },
  { name: 'demo-offline', status: 'failed', source: 'user' },
];
// 保留全部内置工具（它们是 Claude Code 自己的，不暴露使用者），只把第三方
// MCP 工具换成两个合成的。translator 只关心"是不是数组、长度多少"。
const DEMO_MCP_TOOLS = ['mcp__demo__search', 'mcp__demo__fetch'];
const DEMO_SKILLS = ['example-skill', 'example-review-skill'];
const DEMO_SLASH = ['help', 'init', 'config', 'review', 'test'];

// ── 文本级替换 ──────────────────────────────────────────────────────────────
// 本机专属规则排在前面（更具体），通用规则兜底。
const TEXT_RULES = [
  ...LOCAL.paths,
  // 用户主目录
  [/[A-Za-z]:\\Users\\[^\\\s"',:]+/g, 'C:\\Users\\user'],
  // Desktop 是最容易带出项目名的地方，不依赖用户名形态，单独一条
  [/\/Users\/[^/\s"',:]+\/Desktop\/[^/\s"',:]+/g, '/home/user/project'],
  [/\/Users\/[^/\s"',:]+/g, '/home/user'],
  // Claude Code 把目录名压成 slug 存进 memory_paths（形如 C--foo--bar）。
  // 那种形态里没有反斜杠，上面的用户名规则够不着，但项目名照样漏得出去。
  [/C--[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g, 'C--work--project'],
  // 真实会话标识：UUID 与 tool_use id
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'scrubbed-0000'],
  [/\btoolu_[A-Za-z0-9]+/g, 'toolu_scrubbed'],
];

/** 把整棵树里的字符串过一遍 TEXT_RULES。 */
function scrubText(s) {
  let out = s;
  for (const [re, to] of TEXT_RULES) out = out.replace(re, to);
  return out;
}

/** 递归处理：字符串走文本规则，数组/对象逐层下去。 */
function scrubNode(node) {
  if (Array.isArray(node)) return node.map(scrubNode);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = scrubKey(k, v);
    return out;
  }
  if (typeof node === 'string') return scrubText(node);
  return node;
}

/** 结构化的键单独处理——这些字段有"该长什么样"的语义，不能只做字符串替换。 */
function scrubKey(key, val) {
  switch (key) {
    case 'cwd':
      return PROJECT_DIR;

    case 'model':
      return DEMO_MODEL;

    case 'tools': {
      if (!Array.isArray(val)) return scrubNode(val);
      const builtin = val.filter((t) => typeof t === 'string' && !t.startsWith('mcp__'));
      return builtin.concat(DEMO_MCP_TOOLS);
    }

    case 'mcp_servers':
      return Array.isArray(val) ? DEMO_MCP_SERVERS.map((s) => ({ ...s })) : val;

    case 'skills':
      return Array.isArray(val) ? DEMO_SKILLS.slice() : val;

    case 'slash_commands':
    case 'terminal_slash_commands':
      return Array.isArray(val) ? DEMO_SLASH.slice() : val;

    case 'messaging_socket_path':
      return DEMO_PIPE;

    case 'modelUsage': {
      // 键就是模型名，把所有模型档位并成一个，值里的模型标识一并归一
      if (!val || typeof val !== 'object') return val;
      const first = Object.values(val)[0] || {};
      const merged = { ...first, canonicalModel: DEMO_MODEL, provider: 'firstParty' };
      return { [DEMO_MODEL]: merged };
    }

    default:
      return scrubNode(val);
  }
}

// ── 体检 ────────────────────────────────────────────────────────────────────
// 路径 / UUID / MCP 工具名这类检查，必须跑在**解析后的值**上，不能跑在 JSON
// 行文本上：行文本里反斜杠已经被转义成两个，正则既会漏报也会误报
//（`C:\\work\\project` 会被当成"未脱敏路径"报出来，而真正的家目录路径
//  反而因为分隔符对不上而整个漏过去）。
const SAFE_WIN_ROOTS = ['c:\\work', 'c:\\windows', 'c:\\users\\user'];

function walkStrings(node, fn) {
  if (Array.isArray(node)) return node.forEach((v) => walkStrings(v, fn));
  if (node && typeof node === 'object') return Object.values(node).forEach((v) => walkStrings(v, fn));
  if (typeof node === 'string') fn(node);
}

function checkValue(s, where, out) {
  const mac = s.match(/\/Users\/[^/\s"]+/);
  if (mac) out.push({ where, kind: 'macOS 家目录路径', value: mac[0] });

  // Windows 绝对路径：逐个切出来，逐个比对根目录白名单
  for (const m of s.match(/[A-Za-z]:\\[^\s"]*/g) || []) {
    if (!SAFE_WIN_ROOTS.some((root) => m.toLowerCase().startsWith(root))) {
      out.push({ where, kind: '未脱敏的 Windows 路径', value: m.slice(0, 80) });
    }
  }

  for (const u of s.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) || []) {
    out.push({ where, kind: '未脱敏的 UUID', value: u });
  }

  for (const m of s.match(/mcp__(?!demo__)[A-Za-z0-9_-]+/g) || []) {
    out.push({ where, kind: '第三方 MCP 工具名', value: m });
  }
}

// 兜底类：本机专有的敏感词，来自 gitignore 的 .scrub-denylist.json。
// 通用规则漏了什么由它接住——但它本身不能进版本库。
const DENY_STRINGS = LOCAL.strings;

const SECRET_RES = [/sk-[A-Za-z0-9_-]{8,}/, /Bearer\s+[A-Za-z0-9._-]{8,}/];

/** 扫描一个样本，返回问题清单。空数组 = 干净。每项形如 {where, kind, value}。 */
function audit(text, label) {
  const problems = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const where = `${label}:${i + 1}`;

    let parsed = null;
    try { parsed = JSON.parse(line); } catch { /* 非 JSON 行只做行文本检查 */ }
    if (parsed) walkStrings(parsed, (s) => checkValue(s, where, problems));

    // 敏感串与密钥形态在行文本上查，JSON 化和原文两种情况都覆盖
    for (const s of DENY_STRINGS) {
      if (line.includes(s)) problems.push({ where, kind: '含敏感串', value: s });
    }
    for (const re of SECRET_RES) {
      for (const m of line.match(new RegExp(re.source, 'g')) || []) {
        problems.push({ where, kind: '疑似密钥', value: m.slice(0, 24) });
      }
    }
  });
  return problems;
}

/**
 * 一次抓包能漏出几十个 MCP 工具名和上百个 UUID，逐条打印没人看得下去。
 * 按「类型 + 值」归并，附出现次数。
 */
function formatProblems(problems, limit = 20) {
  const groups = new Map();
  for (const p of problems) {
    const key = `${p.kind}  →  ${p.value}`;
    const g = groups.get(key);
    if (g) g.n++;
    else groups.set(key, { n: 1, where: p.where });
  }
  const all = [...groups.entries()];
  const out = all.slice(0, limit).map(([key, g]) => `    ${key}${g.n > 1 ? `   ×${g.n}` : ''}`);
  if (all.length > limit) out.push(`    …… 另有 ${all.length - limit} 类`);
  return out;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
function scrubText_whole(raw) {
  return raw
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => JSON.stringify(scrubNode(JSON.parse(line))))
    .join('\n') + '\n';
}

function main(argv) {
  const args = argv.slice(2);
  const inPlace = args.includes('--in-place');
  const checkOnly = args.includes('--check');
  const files = args.filter((a) => !a.startsWith('--'));

  if (files.length === 0) {
    console.error('用法: node tools\\scrub-fixture.js [--in-place|--check] <file.ndjson> [...]');
    return 2;
  }

  let failed = 0;

  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error(`✗ ${f} 不存在`);
      failed++;
      continue;
    }
    const raw = fs.readFileSync(f, 'utf8');
    const label = path.basename(f);

    if (checkOnly) {
      const problems = audit(raw, label);
      if (problems.length) {
        console.error(`✗ ${label} 未脱敏，${problems.length} 处、${new Set(problems.map((p) => p.kind + p.value)).size} 类：`);
        for (const l of formatProblems(problems)) console.error(l);
        failed++;
      } else {
        console.log(`✓ ${label} 已脱敏`);
      }
      continue;
    }

    const cleaned = scrubText_whole(raw);
    // 洗完立刻自查：宁可这里退出码非零，也别把没洗干净的文件写出去。
    const problems = audit(cleaned, label);
    if (problems.length) {
      console.error(`✗ ${label} 清洗结果仍不合格，已放弃写入：`);
      for (const l of formatProblems(problems)) console.error(l);
      failed++;
      continue;
    }
    if (inPlace) {
      if (cleaned === raw) {
        console.log(`· ${label} 已经是干净的（幂等）`);
      } else {
        fs.writeFileSync(f, cleaned, 'utf8');
        console.log(`✓ ${label} 已脱敏`);
      }
    } else {
      fs.writeFileSync(files[files.indexOf(f) + 1] || f, cleaned, 'utf8');
    }
  }

  return failed ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv));
module.exports = { scrubText_whole, audit };
