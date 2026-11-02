#!/usr/bin/env node
/* batch_shots.mjs — fresh render + sequential screenshot of all stage HTMLs. */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = __dirname;
const loopFile = path.resolve(base, "..", "..", "..", "..", "tmp_loop.txt");

// Step 1: re-render HTMLs
console.log("=== render ===");
const render = spawnSync(process.execPath, [path.join(base, "render.mjs"), loopFile, base], {
  encoding: "utf8", stdio: "pipe",
});
if (render.status !== 0) { console.error("render fail:", render.stderr); process.exit(1); }

const stages = [
  { h: "doctor.html",  out: "01-doctor.png",    port: 9001 },
  { h: "build.html",   out: "02-build.png",     port: 9002 },
  { h: "flash.html",   out: "03-flash.png",     port: 9003 },
  { h: "debug.html",   out: "04-debug.png",     port: 9004 },
  { h: "monitor.html", out: "05-monitor.png",   port: 9005 },
  { h: "full.html",    out: "06-full-loop.png", port: 9006 },
];

console.log("\n=== shots ===");
for (const s of stages) {
  // Verify HTML file is real (has .term class)
  const htmlPath = path.join(base, s.h);
  const content = fs.readFileSync(htmlPath, "utf8");
  if (!content.includes('class="term"')) {
    console.error(`  SKIP ${s.h} — corrupted (no .term)`);
    continue;
  }
  const r = spawnSync(process.execPath, [path.join(base, "shot_one.mjs"), htmlPath, path.join(base, s.out), String(s.port)], {
    encoding: "utf8", stdio: "pipe", timeout: 20000,
  });
  const log = (r.stdout + r.stderr).trim();
  console.log(`  ${s.out}: ${log.split("\n").slice(-2).join(" | ")}`);
}
console.log("\n=== done ===");
