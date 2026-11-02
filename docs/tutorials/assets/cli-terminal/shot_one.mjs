#!/usr/bin/env node
/* shot_one.mjs v3 — screenshot HTML via http://localhost (no file:// issues). */
import fs from "node:fs";
import http from "node:http";

const [htmlFile, outPng, httpPort] = process.argv.slice(2);
if (!htmlFile || !outPng) { console.error("usage: node shot_one.mjs <html> <out> [httpPort]"); process.exit(1); }
const port = parseInt(httpPort || "8765", 10);

const v = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});

let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});
function send(method, params = {}, sessionId) {
  const mid = ++id;
  const payload = { id: mid, method, params };
  if (sessionId) payload.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify(payload));
  });
}

// Start HTTP server to serve HTML file
const absPath = fs.realpathSync(htmlFile);
const htmlContent = fs.readFileSync(absPath, "utf8");
const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(htmlContent),
  });
  res.end(htmlContent);
});
server.listen(port, "127.0.0.1");
await new Promise((r) => setTimeout(r, 200));

try {
  const url = `http://127.0.0.1:${port}/`;
  const tgt = await send("Target.createTarget", { url });
  const attached = await send("Target.attachToTarget", { targetId: tgt.targetId, flatten: true });
  const sid = attached.sessionId;

  await send("Page.enable", {}, sid);
  await send("Runtime.enable", {}, sid);
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 3500, deviceScaleFactor: 2, mobile: false,
  }, sid);
  await new Promise((r) => setTimeout(r, 900));

  // Find .term element
  const clipRes = await send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector('.term');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, r.x - 2), y: Math.max(0, r.y - 2), w: r.width + 4, h: Math.max(r.height, el.scrollHeight) + 4 };
    })()`,
  }, sid);

  let clip = clipRes.result.value;
  if (!clip) {
    console.warn("  .term not found, using body scroll");
    clip = { x: 0, y: 0, w: 1400, h: 900 };
  }

  const res = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: clip.x, y: clip.y, width: clip.w, height: Math.min(clip.h, 4000), scale: 2 },
    captureBeyondViewport: true,
  }, sid);

  fs.writeFileSync(outPng, Buffer.from(res.data, "base64"));
  console.log(`✓ ${outPng} (${Math.round(clip.w)}×${Math.round(clip.h)})`);

  await send("Target.closeTarget", { targetId: tgt.targetId });
} catch (e) {
  console.error("FAIL:", e.message);
} finally {
  server.close();
  ws.close();
}
