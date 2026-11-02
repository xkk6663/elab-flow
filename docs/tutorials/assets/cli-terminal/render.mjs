#!/usr/bin/env node
/* render.mjs —— 把 elab CLI 原始输出渲染成带 PowerShell 风格的彩色终端 HTML
 * 用法：node render.mjs <loop.txt> <outdir>            # 生成 stage-*.html（手动截图）
 *       node render.mjs <loop.txt> <outdir> --full     # 只生成 full loop HTML
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const inPath = process.argv[2];
const outDir = process.argv[3];
const onlyFull = process.argv.includes("--full");

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const raw = readFileSync(inPath, "utf8");
const rawLines = raw.split(/\r?\n/);

function colorizeLine(line) {
  const esc = (cls, text) => `<span class="${cls}">${text}</span>`;
  if (!line) return line;

  // 阶段标题
  if (/^\[\d\/\d\]\s+doctor/.test(line)) return esc("stage-head-doctor", line);
  if (/^\[\d\/\d\]\s+build/.test(line)) return esc("stage-head-build", line);
  if (/^\[\d\/\d\]\s+flash/.test(line)) return esc("stage-head-flash", line);
  if (/^\[\d\/\d\]\s+debug/.test(line)) return esc("stage-head-debug", line);
  if (/^\[\d\/\d\]\s+monitor/.test(line)) return esc("stage-head-monitor", line);
  if (/^={10,}$/.test(line)) return esc("rule", line);
  if (/^\s*\[✓\]/.test(line)) return esc("summary-ok", line);
  if (/^\s*\[✗\]|\s*\[✕\]/.test(line)) return esc("summary-fail", line);
  if (line.startsWith("[elab] ✓✓")) return esc("summary-ok", line);
  if (line.startsWith("[elab] ✓")) return esc("elab-ok", line);
  if (line.startsWith("[elab] ✗") || line.startsWith("[elab] ✕")) return esc("elab-fail", line);
  if (line.startsWith("[elab] ")) return esc("elab-prefix", "[elab] ") + esc("elab-info", line.slice(7));
  if (line.startsWith("[monitor] ✓")) return esc("monitor-ok", line);
  if (line.startsWith("[monitor] ✗")) return esc("monitor-fail", line);
  if (line.startsWith("[monitor] ")) return esc("monitor", line);
  if (line.startsWith("[serial] ")) {
    const alive = line.match(/\[alive\] tick=\d+/);
    if (alive) {
      return esc("serial", line.replace(/\[alive\] tick=\d+/, esc("alive-ping", alive[0])));
    }
    const boot = line.match(/\[boot\][^\s]*/);
    if (boot) return esc("serial", line.replace(/\[boot\][^\s]*/, esc("boot-ping", boot[0])));
    return esc("serial", line);
  }

  // 标签着色
  let m;
  m = line.match(/\s*\[OK\s*\]/);
  if (m) { line = esc("tag-ok", m[0]) + line.slice(m.index + m[0].length); return line; }
  m = line.match(/\s*\[FAIL\]/);
  if (m) { line = esc("tag-fail", m[0]) + line.slice(m.index + m[0].length); return line; }
  m = line.match(/\s*\[info\]/);
  if (m) { line = esc("tag-info", m[0]) + line.slice(m.index + m[0].length); return line; }
  m = line.match(/\s*\[warn\]/);
  if (m) { line = esc("tag-warn", m[0]) + line.slice(m.index + m[0].length); return line; }

  if (/^Open On-Chip|^Info :|^\*\* Programming|^\*\* Verify|^\*\* Verified|^target halted|^shutdown command|^adapter speed|^Info : device|^Info : flash|^Info : SWD/.test(line))
    return esc("openocd", line);
  if (/^\[\d+\/\d+\]/.test(line)) return esc("ninja", line);
  if (/^-- \[elab\]|^Build type:|^-- Configuring|^-- Generating|^Build files/.test(line)) return esc("cmake-info", line);
  if (line.includes("warning:") || line.includes("Wcomment")) return esc("gcc-warn", line);
  if (line.includes("error:")) return esc("gcc-err", line);
  if (/^In file included from|^\s*\d+\s*\|\s|^\s+\|/.test(line)) return esc("gcc-ctx", line);

  return line;
}

function terminalHtml(title, bodyLines) {
  const body = bodyLines.map((ln) => {
    if (typeof ln !== "string") ln = "";
    // Already-HTML lines (prompt <div>, command <div>) — pass through unchanged
    if (ln.startsWith("<div")) return ln;
    // Raw output lines — escape HTML specials, then apply colorize, then wrap in div.ln
    const safe = ln.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
    return `<div class="ln">${colorizeLine(safe)}</div>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${title}</title>
<style>
html,body{margin:0;background:#0d1117;color:#c9d1d9;font-family:'Cascadia Code','Consolas','Menlo',monospace}
body{padding:20px}
.term{background:#0d1117;border:1px solid #30363d;border-radius:10px;overflow:visible}
.term-head{display:flex;gap:8px;align-items:center;padding:10px 14px;background:#161b22;border-bottom:1px solid #30363d}
.dot{width:12px;height:12px;border-radius:50%}
.dot.r{background:#ff5f56}.dot.y{background:#ffbd2e}.dot.g{background:#27c93f}
.term-title{margin-left:8px;color:#8b949e;font-size:12px}
.body{padding:14px 18px 20px;font-size:13px;line-height:1.55}
.ln{white-space:pre}
.ln.prompt{color:#58a6ff}
.ln.cmd{color:#e3b341}
.stage-head-doctor,.stage-head-build{color:#7ee787;font-weight:bold}
.stage-head-flash{color:#ff7b72;font-weight:bold}
.stage-head-debug{color:#e3b341;font-weight:bold}
.stage-head-monitor{color:#bc8cff;font-weight:bold}
.rule{color:#484f58}
.tag-ok{color:#7ee787}
.tag-fail{color:#ff7b72;font-weight:bold}
.tag-info{color:#8b949e}
.tag-warn{color:#ffa657;background:#3a2e00}
.elab-prefix{color:#bc8cff;font-weight:bold}
.elab-ok{color:#7ee787;font-weight:bold}
.elab-fail{color:#ff7b72;font-weight:bold}
.elab-info{color:#79c0ff}
.summary-ok{color:#7ee787;font-weight:bold}
.summary-fail{color:#ff7b72;font-weight:bold}
.openocd{color:#ffa657}
.ninja{color:#79c0ff}
.cmake-info{color:#8b949e}
.gcc-warn{color:#ffa657}
.gcc-err{color:#ff7b72}
.gcc-ctx{color:#484f58}
.serial{color:#79c0ff}
.monitor{color:#f0883e}
.monitor-ok{color:#7ee787;font-weight:bold}
.monitor-fail{color:#ff7b72;font-weight:bold}
.alive-ping{color:#bc8cff;font-weight:bold}
.boot-ping{color:#7ee787;font-weight:bold}
.cursor::after{content:'▋';animation:blink 1s infinite;color:#c9d1d9}
@keyframes blink{50%{opacity:0}}
</style></head>
<body><div class="term">
<div class="term-head"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
<span class="term-title">elab — ${title}</span></div>
<div class="body">${body}<div class="ln cmd cursor"></div></div>
</div></body></html>`;
}

// 切分阶段
const markers = [];
rawLines.forEach((ln, i) => {
  const m = ln.match(/^\[(\d)\/(\d)\]\s+(\S+)/);
  if (m) markers.push({ idx: i, name: m[3] });
});
const ranges = markers.map((m, i) => ({
  name: m.name, start: m.idx, end: i + 1 < markers.length ? markers[i + 1].idx : rawLines.length,
}));

const stageCmds = {
  doctor: "elab doctor",
  build: "elab build -p f411 -v",
  flash: "elab flash -p f411 -v",
  debug: "elab debug -p f411",
  monitor: "elab monitor -p f411 --port COM10 --seconds 10",
};

const promptPs = '<div class="ln prompt">PS C:\\Users\\xiao1\\Desktop\\ELAB\\dsh-elab-flow></div>';
const promptElab = '<div class="ln prompt">elab PS></div>';

if (!onlyFull) {
  for (const st of ranges) {
    const lines = [promptPs, `<div class="ln cmd">${stageCmds[st.name] ?? `elab ${st.name}`}</div>`];
    lines.push(...rawLines.slice(st.start, st.end));
    writeFileSync(`${outDir}/${st.name}.html`, terminalHtml(`闭环 · ${st.name} 阶段`, lines), "utf8");
    console.log(`  ${outDir}/${st.name}.html`);
  }
}

// 完整 loop
const fullLines = [
  promptPs,
  '<div class="ln cmd">$env:PYTHONPATH="services"; $env:ELAB_ROOT="."</div>',
  promptPs,
  '<div class="ln cmd">elab loop -p f411 -v</div>',
  ...rawLines,
];
writeFileSync(`${outDir}/full.html`, terminalHtml("完整闭环：doctor → build → flash → debug → monitor", fullLines), "utf8");
console.log(`  ${outDir}/full.html`);

console.log("done");
