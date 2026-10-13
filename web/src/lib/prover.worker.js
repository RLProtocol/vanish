// Generates Groth16 proofs off the main thread. Downloads the proving key once (with progress).
import * as snarkjs from "snarkjs";

let artifacts = null;

async function download(url, label, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not download ${label} (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

async function load(post) {
  if (artifacts) return artifacts;
  const base = new URL("/circuits/", self.location.origin);
  let wasmLoaded = 0, zkeyLoaded = 0, wasmTotal = 3.2e6, zkeyTotal = 12.3e6;
  const report = () => post({ type: "progress", stage: "download", loaded: wasmLoaded + zkeyLoaded, total: wasmTotal + zkeyTotal });
  const [wasm, zkey] = await Promise.all([
    download(new URL("transaction.wasm", base), "circuit", (l, t) => { wasmLoaded = l; wasmTotal = t || wasmTotal; report(); }),
    download(new URL("transaction.zkey", base), "proving key", (l, t) => { zkeyLoaded = l; zkeyTotal = t || zkeyTotal; report(); }),
  ]);
  artifacts = { wasm, zkey };
  return artifacts;
}

self.onmessage = async ({ data }) => {
  const { id, input } = data;
  const post = (msg) => self.postMessage({ id, ...msg });
  try {
    const { wasm, zkey } = await load(post);
    if (!input) return post({ type: "done", proof: null }); // preload only
    post({ type: "progress", stage: "prove" });
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, { type: "mem", data: wasm }, { type: "mem", data: zkey });
    post({ type: "done", proof, publicSignals });
  } catch (e) {
    post({ type: "error", error: e?.message ?? String(e) });
  }
};
