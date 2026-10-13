// Vanish feature-video pipeline.
//   node build.mjs <name> tts                 narration -> audio/<name>/*.mp3, measured timeline -> <name>.timing.js
//   node build.mjs <name> preview 3 10.5 ...  stills -> previews/<name>-<t>.png
//   node build.mjs <name> render              all frames -> frames/<name>/*.jpg (30 fps)
//   node build.mjs <name> mux                 soundtrack + encode -> ~/Desktop/Vanish videos/<file>.mp4
// Needs a headless Edge/Chrome on --remote-debugging-port=9336, python edge-tts, ffmpeg-static (../node_modules).
import fs from "fs";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { pathToFileURL } from "url";

const DIR = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, "$1");
const FF = path.join(DIR, "..", "node_modules", "ffmpeg-static", "ffmpeg.exe");
const OUT_DIR = path.join(process.env.USERPROFILE, "OneDrive", "Desktop", "Vanish videos");
const [name, step, ...rest] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.narration.json`), "utf8"));
const VOICE = "en-US-AndrewNeural", RATE = "+6%", GAP = 0.55, LEAD = 0.6, TAIL = 2.4, FPS = 30;

const seconds = (file) => {
  const out = spawnSync(FF, ["-i", file, "-f", "null", "-"], { encoding: "utf8" }).stderr; // ffmpeg reports progress on stderr
  const all = [...out.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  const [, h, m, s] = all[all.length - 1];
  return +h * 3600 + +m * 60 + +s;
};

function tts() {
  const dir = path.join(DIR, "audio", name);
  fs.mkdirSync(dir, { recursive: true });
  let start = LEAD;
  const lines = [];
  for (const l of spec.lines) {
    const file = path.join(dir, `${l.id}.mp3`);
    execFileSync("python", ["-m", "edge_tts", "--voice", VOICE, "--rate", RATE, "--text", l.say ?? l.text, "--write-media", file]);
    const dur = +seconds(file).toFixed(2);
    start += l.pause ?? 0;
    lines.push({ id: l.id, start: +start.toFixed(2), dur, text: l.text });
    start += dur + GAP;
  }
  const duration = +(start - GAP + TAIL).toFixed(2);
  fs.writeFileSync(path.join(DIR, `${name}.timing.js`), `window.TIMING = ${JSON.stringify({ label: spec.label, duration, lines }, null, 2)};\n`);
  for (const l of lines) console.log(`${l.id.padEnd(10)} ${String(l.start).padStart(6)}s  +${l.dur}s`);
  console.log(`duration ${duration}s`);
}

async function browser() {
  const list = await (await fetch("http://127.0.0.1:9336/json")).json();
  const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data);
    if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); } };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: pathToFileURL(path.join(DIR, `${name}.html`)).href });
  await new Promise((r) => setTimeout(r, 2500));
  await ev("document.fonts.ready.then(() => 1)");
  await ev("Promise.all([...document.images].map(i => i.complete ? 1 : new Promise(r => { i.onload = i.onerror = r; })))");
  const shot = async (file, format) => {
    const s = await send("Page.captureScreenshot", { format, quality: format === "jpeg" ? 92 : undefined, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
    fs.writeFileSync(file, Buffer.from(s.data, "base64"));
  };
  return { ev, shot, errors, close: () => ws.close() };
}

async function preview(times) {
  const b = await browser();
  fs.mkdirSync(path.join(DIR, "previews"), { recursive: true });
  for (const t of times) {
    await b.ev(`renderAt(${t})`);
    await new Promise((r) => setTimeout(r, 80));
    await b.shot(path.join(DIR, "previews", `${name}-${t}.png`), "png");
  }
  console.log("errors:", b.errors.length ? b.errors : "none");
  b.close();
}

async function render() {
  const b = await browser();
  const dir = path.join(DIR, "frames", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const total = Math.round((await b.ev("window.DURATION")) * FPS);
  const t0 = Date.now();
  for (let f = 0; f < total; f++) {
    await b.ev(`renderAt(${(f / FPS).toFixed(5)})`);
    await b.shot(path.join(dir, String(f + 1).padStart(6, "0") + ".jpg"), "jpeg");
  }
  console.log(`rendered ${total} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s; errors:`, b.errors.length ? b.errors : "none");
  b.close();
}

function mux() {
  const timing = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.timing.js`), "utf8").replace(/^window\.TIMING = /, "").replace(/;\s*$/, ""));
  const D = timing.duration, lines = timing.lines;
  const inputs = lines.flatMap((l) => ["-i", path.join(DIR, "audio", name, `${l.id}.mp3`)]);
  const n = lines.length;
  const pad = "aevalsrc='0.028*sin(2*PI*110*t)+0.020*sin(2*PI*130.81*t)+0.018*sin(2*PI*164.81*t)+0.011*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.07*t))+0.009*sin(2*PI*329.63*t)*(0.5+0.5*sin(2*PI*0.11*t+1))':s=48000:c=stereo";
  const chime = "aevalsrc='(0.15*sin(2*PI*880*t)+0.085*sin(2*PI*1318.5*t)+0.05*sin(2*PI*1760*t))*exp(-2.2*t)':s=48000:c=stereo";
  const voice = lines.map((l, i) => `[${i}]aresample=48000,adelay=${Math.round(l.start * 1000)}:all=1[v${i}]`).join(";");
  const filter = `${voice};${lines.map((_, i) => `[v${i}]`).join("")}amix=inputs=${n}:normalize=0,aformat=channel_layouts=stereo,volume=1.15[voice];` +
    `[${n}]lowpass=f=900,afade=t=in:d=2.5,afade=t=out:st=${(D - 3.5).toFixed(2)}:d=3.5,volume=0.9[pad];` +
    `[${n + 1}]adelay=${Math.round((lines[n - 1].start - 0.1) * 1000)}:all=1,volume=0.85[chime];` +
    `[voice][pad][chime]amix=inputs=3:normalize=0:duration=longest,atrim=0:${D},alimiter=limit=0.95[out]`;
  const wav = path.join(DIR, `${name}.wav`);
  execFileSync(FF, ["-y", "-loglevel", "error", ...inputs, "-f", "lavfi", "-t", String(D), "-i", pad, "-f", "lavfi", "-t", "3", "-i", chime,
    "-filter_complex", filter, "-map", "[out]", "-ar", "48000", "-c:a", "pcm_s16le", wav]);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mp4 = path.join(OUT_DIR, spec.file);
  execFileSync(FF, ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(DIR, "frames", name, "%06d.jpg"), "-i", wav,
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-profile:v", "high", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-shortest", "-movflags", "+faststart", mp4]);
  console.log(`wrote ${mp4} (${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB, ${D}s)`);
}

if (step === "tts") tts();
else if (step === "preview") await preview(rest.map(Number));
else if (step === "render") await render();
else if (step === "mux") mux();
else console.log("steps: tts | preview <t...> | render | mux");
process.exit(0);
