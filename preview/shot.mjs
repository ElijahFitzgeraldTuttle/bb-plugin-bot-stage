// Screenshot a URL with headless Edge over the DevTools protocol, then close it.
// usage: node preview/shot.mjs <url> <out.png> [waitMs] [width] [height] [jsToRunBeforeShot]
// env: FRAMES, INTERVAL (a series), CLICKS="x,y;x,y" (real mouse input), HOVER="x,y" HOVER_MS
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [url, out, wait = '6000', width = '1500', height = '950', js = ''] = process.argv.slice(2);
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const dir = mkdtempSync(path.join(tmpdir(), 'edge-shot-'));
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(edge, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, `--window-size=${width},${height}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = () => { try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };
try {
  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch {}
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) pending.get(d.id)(d); };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: +width, height: +height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(+wait);
  if (js) { const r = await send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true }); console.log('js:', JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.text)); await sleep(2500); }
  // CLICKS="x,y;x,y" sends real mouse clicks; HOVER="x,y" rests the pointer there.
  const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
  for (const spec of (process.env.CLICKS || "").split(";").filter(Boolean)) {
    const [x, y] = spec.split(",").map(Number);
    await mouse("mouseMoved", x, y, { button: "none", clickCount: 0 });
    await mouse("mousePressed", x, y);
    await mouse("mouseReleased", x, y);
    await sleep(900);
  }
  if (process.env.HOVER) {
    const [x, y] = process.env.HOVER.split(",").map(Number);
    await mouse("mouseMoved", x, y, { button: "none", clickCount: 0 });
    await sleep(Number(process.env.HOVER_MS || 1200));
  }
  // FRAMES=n INTERVAL=ms: take a series from one page session (out-1.png, out-2.png, ...).
  const frames = Number(process.env.FRAMES || 1), interval = Number(process.env.INTERVAL || 4000);
  for (let f = 1; f <= frames; f++) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = frames > 1 ? out.replace(/\.png$/, `-${f}.png`) : out;
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    console.log('saved', file);
    if (f < frames) await sleep(interval);
  }
  ws.close();
} finally {
  kill();
}
