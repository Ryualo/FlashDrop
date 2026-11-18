/**
 * Runs tests/browser in headless Chrome via the DevTools protocol (Node ≥ 22 for global WebSocket).
 *   1. npx tsx scripts/make-fake-camera-video.ts      (optional: enables the camera test)
 *   2. npm run dev                                     (serves http://localhost:3000)
 *   3. CHROME_PATH=/path/to/chrome node scripts/run-browser-tests.mjs [http://localhost:3000]
 * Note: the fake camera is a generated video, not a physical camera.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const base = process.argv[2] || 'http://localhost:3000';
const chrome = process.env.CHROME_PATH || 'google-chrome';
const port = 9333;
const video = path.resolve('tests/browser/fake-camera.y4m');
const args = [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'flashdrop-chrome-'))}`, '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  ...(existsSync(video) ? [`--use-file-for-fake-video-capture=${video}`] : []),
  ...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []),
  'about:blank',
];
const proc = spawn(chrome, args, { stdio: 'ignore' });
const deadline = Date.now() + 15000;
let list = null;
while (!list && Date.now() < deadline) {
  try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await new Promise((r) => setTimeout(r, 250)); }
}
if (!list) { proc.kill(); throw new Error('Chrome did not start'); }
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
await send('Page.enable');
await send('Page.navigate', { url: `${base}/tests/browser/index.html` });
for (let i = 0; i < 200; i++) {
  const r = await send('Runtime.evaluate', { expression: 'window.__ready === true', returnByValue: true });
  if (r.result?.result?.value) break;
  await new Promise((r) => setTimeout(r, 100));
}
const r = await send('Runtime.evaluate', { expression: 'runAll()', awaitPromise: true, returnByValue: true, timeout: 300000 });
const out = r.result?.result?.value;
console.log(JSON.stringify(out ?? r, null, 2));
ws.close();
proc.kill();
const failed = !out || Object.values(out).some((v) => v && (v.error || v.verified === false || v.ok === false || v.bufferPath === false || v.bitmapPath === false));
process.exit(failed ? 1 : 0);
