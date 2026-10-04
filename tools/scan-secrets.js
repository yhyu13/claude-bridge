#!/usr/bin/env node
'use strict';
/**
 * scan-secrets.js — 上线前的最后一道闸：扫「将要提交的内容」里有没有本机身份和密钥。
 *
 * 为什么单独一个工具
 * ------------------
 * tools/scrub-fixture.js 只管两份协议样本。这个仓库里会进版本库的东西还有
 * README、AGENTS、DESIGN、示例配置、测试脚本——本项目就是在这几处翻过车：
 *
 *   - 协议样本里带着 5 个 MCP server、60 个工具名、129 条个人 skill
 *   - DESIGN.md 里写了具体的 MCP server 名字
 *   - 测试里的假 token 用了 sk- 字面量，公开后会被 GitHub 密钥扫描误报
 *   - 脱敏器自己把要藏的字符串硬编码在源码里（工具成了泄露源）
 *
 * 这些都不是"运行时"问题，是"提交那一刻"的问题，所以要在提交前扫、扫的是
 * git index 而不是工作目录——工作目录里躺着一堆该忽略的运行时产物。
 *
 * 用法
 *   node tools\scan-secrets.js              扫 git 已暂存/已跟踪的文件
 *   node tools\scan-secrets.js --staged     只扫暂存区（提交前用这个）
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * 本机身份相关的具体串，和 scrub-fixture.js 共用同一份本地规则。
 *
 * 刻意不写死在这里：本项目的教训是，工具一旦把"要藏的字符串"硬编码进源码，
 * 它自己就成了泄露源——脱敏器里那份 denylist 被扫出来时，等于把用户名、
 * 项目名、内部平台名直接印在公开仓库里。规则从 gitignore 的
 * .scrub-denylist.json 读，不进版本库。
 */
const LOCAL_DENYLIST = path.join(__dirname, '..', '.scrub-denylist.json');

function loadLocalStrings() {
  if (!fs.existsSync(LOCAL_DENYLIST)) return [];
  try {
    const cfg = JSON.parse(fs.readFileSync(LOCAL_DENYLIST, 'utf8'));
    return (cfg.strings || []).filter((s) => typeof s === 'string' && s);
  } catch (e) {
    console.error(`! ${path.basename(LOCAL_DENYLIST)} 解析失败，已忽略：${e.message}`);
    return [];
  }
}

const DENY_STRINGS = loadLocalStrings();

/**
 * 通用形态。与本机无关，任何人都适用。
 * 每一项写成 [正则, 说明, 是否豁免]，豁免的是"合法但长得像"的正常内容。
 */
const SHAPE_RULES = [
  [/sk-[A-Za-z0-9_-]{8,}/g, '疑似 Anthropic key（sk- 前缀）'],
  [/Bearer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer 令牌'],
  [/ANTHROPIC_(?:AUTH_TOKEN|API_KEY)\s*[:=]\s*["']?[A-Za-z0-9_-]{12,}/g, 'ANTHROPIC 凭据赋值'],
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, 'IPv4 字面量（确认不是 0.0.0.0/127.0.0.1 等占位）'],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID（可能是真实会话 id）'],
  [/mcp__(?!demo__)[a-z0-9_-]+/gi, '第三方 MCP 工具名'],
  [/\/(?:Users|home)\/[A-Za-z0-9._-]+/g, '家目录路径'],
  [/[A-Za-z]:\\Users\\[^\\\s"']+/g, 'Windows 家目录路径'],
];

// 上面几条形态规则，文档和示例里大量出现正常内容，必须豁免，
// 否则工具天天误报，两周内所有人都会开始无视它。
const IP_ALLOW = new Set(['0.0.0.0', '127.0.0.1', '1.1.1.1', '255.255.255.255']);
const UUID_ALLOW = /^(?:scrubbed-0000|00000000-0000-0000-0000-000000000000)$/i;
// 家目录末段是 <name> / {{name}} / user / example 这类占位符时放过——
// 文档里写 `C:\Users\<name>\...` 说明用法是正常的，不该报。
const HOME_ALLOW = /^\/(?:Users|home)\/(?:user|runner|node|example|yourname)$/i;
const WIN_HOME_ALLOW = /^[A-Za-z]:\\Users\\(?:user|runner|node|example|yourname)$/i;
const PLACEHOLDER_SEG = /^(?:<[^>]+>|\{\{[^}]*\}\})$/;

function isExempt(kind, value) {
  if (kind === 'IPv4 字面量（确认不是 0.0.0.0/127.0.0.1 等占位）') return IP_ALLOW.has(value);
  if (kind === 'UUID（可能是真实会话 id）') return UUID_ALLOW.test(value);
  if (kind === '家目录路径') return HOME_ALLOW.test(value) || PLACEHOLDER_SEG.test(value.split('/').pop());
  if (kind === 'Windows 家目录路径') return WIN_HOME_ALLOW.test(value) || PLACEHOLDER_SEG.test(value.split('\\').pop());
  return false;
}

/**
 * 该扫哪些文件：优先暂存区，没有暂存就扫已跟踪文件。
 * 不在 git 仓库里（下载 zip 解压用）就跳过——这个检查的意义在"提交那一刻"，
 * 没有 git 就没有提交可言，不该因此让 verify 挂掉。
 */
function targetFiles() {
  const args = process.argv.slice(2);
  const opts = args.includes('--staged') ? ['--cached'] : [];
  let out = '';
  try {
    out = execFileSync('git', ['ls-files', ...opts], { encoding: 'utf8' });
  } catch {
    console.log('· scan-secrets：不在 git 仓库里，跳过（这个检查针对的是提交内容）');
    process.exit(0);
  }
  const files = out.split(/\r?\n/).filter(Boolean);
  if (!files.length) {
    console.log('· scan-secrets：没有已跟踪文件，跳过');
    process.exit(0);
  }
  return files;
}

function main() {
  const files = targetFiles();
  const findings = [];

  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }

    text.split(/\r?\n/).forEach((line, i) => {
      const where = `${f}:${i + 1}`;

      for (const d of DENY_STRINGS) {
        if (line.includes(d)) findings.push({ where, kind: '本机身份串', value: d });
      }
      for (const [re, kind] of SHAPE_RULES) {
        for (const m of line.match(re) || []) {
          if (isExempt(kind, m)) continue;
          findings.push({ where, kind, value: m });
        }
      }
    });
  }

  if (!findings.length) {
    console.log(`✓ scan-secrets：${files.length} 个文件，未发现本机身份信息或密钥`);
    return 0;
  }

  const groups = new Map();
  for (const p of findings) {
    const key = `${p.kind}  →  ${p.value}`;
    const g = groups.get(key);
    if (g) { g.n++; g.first = g.first || p.where; } else groups.set(key, { n: 1, first: p.where });
  }

  console.error(`✗ scan-secrets：${findings.length} 处、${groups.size} 类问题\n`);
  for (const [key, g] of groups) {
    console.error(`    ${key}${g.n > 1 ? `   ×${g.n}` : ''}`);
    console.error(`        首次出现在 ${g.first}`);
  }
  console.error('\n确认是误报的话，在对应规则里加进白名单（isExempt），不要删规则。');
  return 1;
}

if (require.main === module) process.exit(main());
module.exports = { SHAPE_RULES, isExempt };
