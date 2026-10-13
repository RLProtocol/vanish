// Renders promo.html deterministically through the headless browser's DevTools protocol.
//   node capture.mjs preview 1.5 6.6 11 ...   -> preview-<t>.png
//   node capture.mjs frames [fps]              -> frames/000001.jpg ... (whole video)
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

const dir = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, "$1");
const mode = process.argv[2] ?? "preview";
const list = await (await fetch("http://127.0.0.1:9336/json")).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data);
  if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: pathToFileURL(path.join(dir, "promo.html")).href });
await sleep(2500);
await ev("document.fonts.ready.then(() => document.fonts.size)");
await ev("Promise.all([...document.images].map(i => i.complete ? 1 : new Promise(r => { i.onload = i.onerror = r; })))");
console.log("fonts:", await ev("[...document.fonts].filter(f => f.status === 'loaded').map(f => f.family).filter((v,i,a)=>a.indexOf(v)===i).join(', ')"));

const shot = async (file, format = "png") => {
  const s = await send("Page.captureScreenshot", { format, quality: format === "jpeg" ? 92 : undefined, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
  fs.writeFileSync(file, Buffer.from(s.data, "base64"));
};

if (mode === "preview") {
  for (const t of process.argv.slice(3).map(Number)) {
    await ev(`renderAt(${t})`);
    await sleep(60);
    await shot(path.join(dir, `preview-${t}.png`));
  }
} else {
  const fps = Number(process.argv[3] ?? 30);
  const total = Math.round((await ev("window.DURATION")) * fps);
  fs.mkdirSync(path.join(dir, "frames"), { recursive: true });
  const t0 = Date.now();
  for (let f = 0; f < total; f++) {
    await ev(`renderAt(${(f / fps).toFixed(5)})`);
    await shot(path.join(dir, "frames", String(f + 1).padStart(6, "0") + ".jpg"), "jpeg");
    if (f % 150 === 0) console.log(`frame ${f}/${total} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  console.log(`rendered ${total} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
console.log("errors:", errors.length ? errors : "none");
ws.close();
process.exit(0);
