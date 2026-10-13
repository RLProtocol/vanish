// Vanish client: PDAs, instruction encoding, proof encoding, pool sync and shield/unshield.
// Works in Node and the browser. Proof generation is injected (`prove`) so Node can use
// snarkjs directly and the browser can use a Web Worker.
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { Buffer } from "buffer";
import { FIELD_SIZE, Keypair, Utxo, assetId, fromBytes, mod, toBytes32 } from "./crypto.js";
import { MerkleTree } from "./merkleTree.js";
import { ASSETS, NATIVE_SOL, assetByMint } from "./assets.js";

export const LEVELS = 20;
export const ROOT_HISTORY = 100;
const BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

const DISC = {
  initialize: [175, 175, 109, 31, 13, 152, 155, 237],
  add_sol_asset: [118, 33, 127, 71, 67, 213, 125, 23],
  add_token_asset: [17, 191, 18, 230, 45, 67, 193, 240],
  set_asset: [243, 216, 48, 30, 63, 58, 91, 239],
  transact: [217, 149, 130, 143, 221, 52, 252, 119],
  TransactEvent: [89, 245, 87, 250, 222, 30, 135, 142],
};

// ---------------------------------------------------------------------------- byte helpers

export class Writer {
  constructor() {
    this.parts = [];
  }
  bytes(b) {
    this.parts.push(Uint8Array.from(b));
    return this;
  }
  u8(v) {
    return this.bytes([v]);
  }
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    return this.bytes(b);
  }
  u64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
    return this.bytes(b);
  }
  i64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, BigInt(v), true);
    return this.bytes(b);
  }
  vec(b) {
    return this.u32(b.length).bytes(b);
  }
  done() {
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

export class Reader {
  constructor(b) {
    this.b = b;
    this.o = 0;
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  take(n) {
    const out = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return out;
  }
  u32() {
    const x = this.v.getUint32(this.o, true);
    this.o += 4;
    return x;
  }
  u64() {
    const x = this.v.getBigUint64(this.o, true);
    this.o += 8;
    return x;
  }
  i64() {
    const x = this.v.getBigInt64(this.o, true);
    this.o += 8;
    return x;
  }
  vec() {
    return this.take(this.u32());
  }
}

const b64 = (s) => (typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---------------------------------------------------------------------------- program layout

export function pdas(programId) {
  const pid = new PublicKey(programId);
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from("pool")], pid);
  const [solVault] = PublicKey.findProgramAddressSync([Buffer.from("sol_vault")], pid);
  return {
    programId: pid,
    pool,
    solVault,
    asset: (mint) => PublicKey.findProgramAddressSync([Buffer.from("asset"), new PublicKey(mint).toBuffer()], pid)[0],
    nullifier: (n) => PublicKey.findProgramAddressSync([Buffer.from("nullifier"), Buffer.from(toBytes32(n))], pid)[0],
    vault: (asset) => getAssociatedTokenAddressSync(new PublicKey(asset.mint), pool, true, new PublicKey(asset.tokenProgram)),
  };
}

/** keccak256(recipient | ext_amount LE | relayer | fee LE | mint | enc1 | enc2) mod p — same as the program. */
export function extDataHash({ recipient, extAmount, relayer, fee, mint, enc1, enc2 }) {
  const data = new Writer()
    .bytes(new PublicKey(recipient).toBytes())
    .i64(extAmount)
    .bytes(new PublicKey(relayer).toBytes())
    .u64(fee)
    .bytes(new PublicKey(mint).toBytes())
    .bytes(enc1)
    .bytes(enc2)
    .done();
  return fromBytes(keccak_256(data)) % FIELD_SIZE;
}

/** snarkjs proof -> groth16-solana bytes: -A | B (c1,c0 per coordinate) | C, all big-endian. */
export function encodeProof(proof) {
  const be = (x) => toBytes32(BigInt(x));
  const out = new Uint8Array(256);
  out.set(be(proof.pi_a[0]), 0);
  out.set(be((BASE_FIELD - BigInt(proof.pi_a[1])) % BASE_FIELD), 32);
  out.set(be(proof.pi_b[0][1]), 64);
  out.set(be(proof.pi_b[0][0]), 96);
  out.set(be(proof.pi_b[1][1]), 128);
  out.set(be(proof.pi_b[1][0]), 160);
  out.set(be(proof.pi_c[0]), 192);
  out.set(be(proof.pi_c[1]), 224);
  return out;
}

/** TransactArgs as borsh, without an instruction discriminator. */
export function encodeTransactArgs(a, w = new Writer()) {
  return w
    .vec(a.proof)
    .bytes(toBytes32(a.root))
    .bytes(toBytes32(a.inputNullifiers[0]))
    .bytes(toBytes32(a.inputNullifiers[1]))
    .bytes(toBytes32(a.outputCommitments[0]))
    .bytes(toBytes32(a.outputCommitments[1]))
    .i64(a.extAmount)
    .u64(a.fee)
    .vec(a.enc1)
    .vec(a.enc2)
    .done();
}

export function transactInstruction({ programId, signer, asset, recipient, relayer, depositorToken, args }) {
  const P = pdas(programId);
  const isSol = asset.mint === NATIVE_SOL;
  const ph = { pubkey: P.programId, isSigner: false, isWritable: false }; // Anchor "None" placeholder
  const w = (k) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: true });
  const r = (k) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: false });
  const keys = [
    { pubkey: new PublicKey(signer), isSigner: true, isWritable: true },
    w(P.pool),
    r(P.asset(asset.mint)),
    w(P.nullifier(args.inputNullifiers[0])),
    w(P.nullifier(args.inputNullifiers[1])),
    w(recipient),
    w(relayer),
    w(P.solVault),
    isSol ? ph : r(asset.mint),
    isSol ? ph : w(P.vault(asset)),
    depositorToken ? w(depositorToken) : ph,
    isSol ? ph : r(asset.tokenProgram),
    r(SystemProgram.programId),
  ];
  return new TransactionInstruction({ programId: P.programId, keys, data: Buffer.from(encodeTransactArgs(args, new Writer().bytes(DISC.transact))) });
}

// admin instructions (used by scripts/setup.mjs)
export function initializeInstruction({ programId, admin }) {
  const P = pdas(programId);
  return new TransactionInstruction({
    programId: P.programId,
    keys: [
      { pubkey: new PublicKey(admin), isSigner: true, isWritable: true },
      { pubkey: P.pool, isSigner: false, isWritable: true },
      { pubkey: P.solVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISC.initialize),
  });
}

const denomsRaw = (asset) => asset.denominations.map((d) => toRaw(d, asset.decimals));

export function addAssetInstruction({ programId, admin, asset }) {
  const P = pdas(programId);
  const data = new Writer().bytes(asset.mint === NATIVE_SOL ? DISC.add_sol_asset : DISC.add_token_asset).u32(asset.denominations.length);
  for (const d of denomsRaw(asset)) data.u64(d);
  const adminMeta = { pubkey: new PublicKey(admin), isSigner: true, isWritable: true };
  const keys =
    asset.mint === NATIVE_SOL
      ? [adminMeta, { pubkey: P.pool, isSigner: false, isWritable: true }, { pubkey: P.asset(asset.mint), isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }]
      : [
          adminMeta,
          { pubkey: P.pool, isSigner: false, isWritable: true },
          { pubkey: new PublicKey(asset.mint), isSigner: false, isWritable: false },
          { pubkey: P.asset(asset.mint), isSigner: false, isWritable: true },
          { pubkey: P.vault(asset), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(asset.tokenProgram), isSigner: false, isWritable: false },
          { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ];
  return new TransactionInstruction({ programId: P.programId, keys, data: Buffer.from(data.done()) });
}

/** Admin: change deposit sizes (raw units) and/or pause deposits. Pass null to leave a field unchanged. */
export function setAssetInstruction({ programId, admin, mint, denominations = null, paused = null }) {
  const P = pdas(programId);
  const w = new Writer().bytes(DISC.set_asset);
  if (denominations) {
    w.u8(1).u32(denominations.length);
    for (const d of denominations) w.u64(d);
  } else w.u8(0);
  if (paused === null) w.u8(0);
  else w.u8(1).u8(paused ? 1 : 0);
  return new TransactionInstruction({
    programId: P.programId,
    keys: [
      { pubkey: new PublicKey(admin), isSigner: true, isWritable: false },
      { pubkey: P.pool, isSigner: false, isWritable: false },
      { pubkey: P.asset(mint), isSigner: false, isWritable: true },
    ],
    data: Buffer.from(w.done()),
  });
}

/** getMultipleAccountsInfo in chunks of 10 (some public RPCs, e.g. PublicNode, reject larger batches). */
export async function getAccountsChunked(connection, keys, commitment = "confirmed", size = 10) {
  const out = [];
  for (let i = 0; i < keys.length; i += size) out.push(...(await connection.getMultipleAccountsInfo(keys.slice(i, i + size), commitment)));
  return out;
}

// ---------------------------------------------------------------------------- amounts

export function toRaw(text, decimals) {
  const [i, f = ""] = String(text).trim().split(".");
  if (!/^\d*$/.test(i) || !/^\d*$/.test(f) || f.length > decimals || (i === "" && f === "")) throw new Error(`bad amount ${text}`);
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}
export function fromRaw(raw, decimals, maxFrac = decimals) {
  const s = BigInt(raw).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

// ---------------------------------------------------------------------------- events

export function parseTransactEvents(logMessages) {
  const out = [];
  for (const line of logMessages ?? []) {
    if (!line.startsWith("Program data: ")) continue;
    const bytes = b64(line.slice(14));
    if (bytes.length < 8 || !eq(bytes.subarray(0, 8), DISC.TransactEvent)) continue;
    const r = new Reader(bytes.subarray(8));
    const mint = new PublicKey(r.take(32));
    const firstIndex = Number(r.u64());
    const commitments = [fromBytes(r.take(32)), fromBytes(r.take(32))];
    const nullifiers = [fromBytes(r.take(32)), fromBytes(r.take(32))];
    const enc = [Uint8Array.from(r.vec()), Uint8Array.from(r.vec())];
    out.push({ mint: mint.toBase58(), firstIndex, commitments, nullifiers, enc, extAmount: r.i64(), fee: r.u64() });
  }
  return out;
}

// ---------------------------------------------------------------------------- proving

/**
 * Builds and proves a 2-in/2-out transaction. `hashExt` overrides the ext-data hash (swap_open
 * binds extra swap terms); it receives the two encrypted outputs.
 */
export async function prepareTransaction({ tree, asset, inputs = [], outputs = [], extAmount = 0n, fee = 0n, recipient, relayer, keypair, prove, onProgress, hashExt = null }) {
  const id = assetId(new PublicKey(asset.mint));
  inputs = [...inputs];
  outputs = [...outputs];
  if (inputs.length > 2 || outputs.length > 2) throw new Error("at most 2 inputs and 2 outputs");
  while (inputs.length < 2) inputs.push(new Utxo({ assetId: id, keypair: new Keypair() }));
  while (outputs.length < 2) outputs.push(new Utxo({ assetId: id, keypair }));
  for (const u of [...inputs, ...outputs]) if (u.assetId !== id) throw new Error("note belongs to a different asset");

  const inPathElements = [];
  const inPathIndices = [];
  for (const u of inputs) {
    if (u.amount > 0n) {
      if (tree.leaves[u.index] !== u.getCommitment()) throw new Error(`note ${u.index} does not match the pool; resync`);
      inPathElements.push(tree.path(u.index).pathElements);
      inPathIndices.push(u.index);
    } else {
      inPathElements.push(new Array(LEVELS).fill(0n));
      inPathIndices.push(0);
    }
  }

  const enc1 = await outputs[0].encrypt();
  const enc2 = await outputs[1].encrypt();
  const hash = hashExt ? hashExt({ enc1, enc2 }) : extDataHash({ recipient, extAmount, relayer, fee, mint: asset.mint, enc1, enc2 });
  const publicAmount = mod(BigInt(extAmount) - BigInt(fee));

  const input = {
    root: tree.root,
    publicAmount,
    extDataHash: hash,
    assetId: id,
    inputNullifier: inputs.map((u) => u.getNullifier()),
    outputCommitment: outputs.map((u) => u.getCommitment()),
    inAmount: inputs.map((u) => u.amount),
    inPrivateKey: inputs.map((u) => u.keypair.privkey),
    inBlinding: inputs.map((u) => u.blinding),
    inPathIndices,
    inPathElements,
    outAmount: outputs.map((u) => u.amount),
    outPubkey: outputs.map((u) => u.keypair.pubkey),
    outBlinding: outputs.map((u) => u.blinding),
  };
  const proof = await prove(input, onProgress);
  return {
    proof: encodeProof(proof),
    root: input.root,
    inputNullifiers: input.inputNullifier,
    outputCommitments: input.outputCommitment,
    extAmount: BigInt(extAmount),
    fee: BigInt(fee),
    enc1,
    enc2,
  };
}

/** Converts BigInts to strings for snarkjs / postMessage. */
export const stringifyInput = (input) =>
  Object.fromEntries(Object.entries(input).map(([k, v]) => [k, JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)))]));

/**
 * A relayer route under `base`, which may carry a path: "https://host/api" + "/info" -> "https://host/api/info".
 * A relative base ("/api") gives a same-origin URL in the browser.
 */
export const relayerEndpoint = (base, path) => `${String(base).replace(/\/+$/, "")}${path}`;

// ---------------------------------------------------------------------------- client

/**
 * @param connection   web3.js Connection
 * @param programId    deployed program
 * @param keypair      shielded Keypair
 * @param prove        (input, onProgress) => snarkjs proof
 * @param storage      optional {get(key), set(key, value)} for caching the tree and notes
 * @param lookupTable  optional AddressLookupTableAccount to shrink transactions
 */
export class SolMixClient {
  constructor({ connection, programId, keypair, prove, storage = null, lookupTable = null, syncBatch = 4, syncDelayMs = 400, onSyncProgress = null }) {
    this.syncBatch = syncBatch;
    this.syncDelayMs = syncDelayMs;
    this.onSyncProgress = onSyncProgress;
    this.connection = connection;
    this.P = pdas(programId);
    this.keypair = keypair;
    this.prove = prove;
    this.storage = storage;
    this.lookupTable = lookupTable;
    this.cacheKey = `solmix:v2:${this.P.programId.toBase58()}:${keypair.pubkey.toString(16).slice(0, 16)}`;
    this.tree = null;
    this.notes = [];
    this.deposits = []; // public deposit log: { index, mint, amount, time }
    this.lastSignature = null;
    this._syncing = null;
  }

  _load() {
    let leaves = [];
    try {
      const raw = this.storage?.get(this.cacheKey);
      if (raw) {
        const c = JSON.parse(raw);
        leaves = c.leaves.map(BigInt);
        this.lastSignature = c.lastSignature;
        this.notes = c.notes.map((n) => ({ ...n, amount: BigInt(n.amount), blinding: BigInt(n.blinding), assetId: BigInt(n.assetId) }));
        this.deposits = (c.deposits ?? []).map((d) => ({ ...d, amount: BigInt(d.amount) }));
      }
    } catch {
      /* corrupt cache: rescan */
    }
    this.tree = new MerkleTree(LEVELS, leaves);
  }

  _save() {
    if (!this.storage) return;
    const ser = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    try {
      this.storage.set(this.cacheKey, ser({ lastSignature: this.lastSignature, leaves: this.tree.leaves, notes: this.notes, deposits: this.deposits }));
    } catch {
      /* storage full or blocked */
    }
  }

  resetCache() {
    this.tree = null;
    this.notes = [];
    this.deposits = [];
    this.lastSignature = null;
    this.storage?.set(this.cacheKey, "");
  }

  async readPool() {
    const info = await this.connection.getAccountInfo(this.P.pool, "confirmed");
    if (!info) throw new Error("pool is not initialized");
    const d = info.data;
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const nextIndex = Number(v.getBigUint64(8 + 32, true));
    const rootIndex = Number(v.getBigUint64(8 + 40, true));
    const rootsAt = 8 + 48 + 32 * LEVELS * 2;
    const root = fromBytes(d.subarray(rootsAt + rootIndex * 32, rootsAt + rootIndex * 32 + 32));
    return { nextIndex, root };
  }

  sync() {
    this._syncing ??= this._sync().finally(() => (this._syncing = null));
    return this._syncing;
  }

  async _sync() {
    if (!this.tree) this._load();
    // newest -> oldest until the last signature we processed
    const sigs = [];
    let before;
    for (;;) {
      const page = await this.connection.getSignaturesForAddress(this.P.pool, { before, until: this.lastSignature ?? undefined, limit: 1000 }, "confirmed");
      sigs.push(...page.filter((s) => !s.err));
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    sigs.reverse();

    // Paced so the public RPC (which rate-limits getTransaction hard) keeps up; private RPCs just go faster.
    const events = [];
    const getTx = async (signature) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        } catch (e) {
          if (attempt >= 6 || !/429|Too Many Requests|rate/i.test(e.message)) throw e;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
    };
    for (let i = 0; i < sigs.length; i += this.syncBatch) {
      const batch = sigs.slice(i, i + this.syncBatch);
      const txs = await Promise.all(batch.map((s) => getTx(s.signature)));
      txs.forEach((tx, j) => {
        if (!tx || tx.meta?.err) return;
        for (const e of parseTransactEvents(tx.meta.logMessages)) events.push({ ...e, signature: batch[j].signature, time: tx.blockTime ?? null });
      });
      this.onSyncProgress?.(Math.min(i + this.syncBatch, sigs.length), sigs.length);
      if (i + this.syncBatch < sigs.length) await new Promise((r) => setTimeout(r, this.syncDelayMs));
    }
    events.sort((a, b) => a.firstIndex - b.firstIndex);

    const newLeaves = [];
    for (const e of events) {
      if (e.extAmount > 0n && !this.deposits.some((d) => d.index === e.firstIndex)) {
        this.deposits.push({ index: e.firstIndex, mint: e.mint, amount: e.extAmount, time: e.time });
      }
    }
    for (const e of events) {
      for (let k = 0; k < 2; k++) {
        const index = e.firstIndex + k;
        const expected = this.tree.leaves.length + newLeaves.length;
        if (index < expected) continue;
        if (index !== expected) throw new Error("Pool history has a gap. Reset the local cache and try again.");
        newLeaves.push(e.commitments[k]);
        const dec = await this.keypair.decrypt(e.enc[k]);
        if (dec && dec.amount > 0n) {
          const id = assetId(new PublicKey(e.mint));
          const u = new Utxo({ amount: dec.amount, blinding: dec.blinding, assetId: id, keypair: this.keypair, index });
          if (u.getCommitment() === e.commitments[k]) {
            this.notes.push({ index, amount: dec.amount, blinding: dec.blinding, assetId: id, mint: e.mint, fromDeposit: e.extAmount > 0n, time: e.time });
          }
        }
      }
    }
    if (newLeaves.length) this.tree.bulkInsert(newLeaves);
    if (sigs.length) this.lastSignature = sigs[sigs.length - 1].signature;

    const onchain = await this.readPool();
    if (onchain.nextIndex === this.tree.leaves.length && onchain.root !== this.tree.root) {
      throw new Error("Local copy of the pool doesn't match the chain. Reset the local cache and try again.");
    }
    this._save();
  }

  _utxo(n) {
    return new Utxo({ amount: n.amount, blinding: n.blinding, assetId: n.assetId, keypair: this.keypair, index: n.index });
  }

  /** All our notes with spent flags. */
  async getNotes() {
    await this.sync();
    const utxos = this.notes.map((n) => ({ utxo: this._utxo(n), mint: n.mint }));
    const keys = utxos.map(({ utxo }) => this.P.nullifier(utxo.getNullifier()));
    const infos = await getAccountsChunked(this.connection, keys);
    return utxos.map((u, i) => ({ ...u, spent: !!infos[i] }));
  }

  async getUnspent(asset) {
    const id = assetId(new PublicKey(asset.mint));
    return (await this.getNotes())
      .filter((n) => !n.spent && n.utxo.assetId === id)
      .map((n) => n.utxo)
      .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  }

  async getBalances() {
    const notes = await this.getNotes();
    const out = {};
    for (const a of ASSETS) {
      const id = assetId(new PublicKey(a.mint));
      const mine = notes.filter((n) => !n.spent && n.utxo.assetId === id);
      out[a.symbol] = { total: mine.reduce((s, n) => s + n.utxo.amount, 0n), notes: mine.length };
    }
    return out;
  }

  /**
   * How well a withdrawal of `asset` would blend in: deposits of the same asset made by anyone
   * after your most recent deposit of it. Zero means a withdrawal now is trivially linkable.
   */
  async anonymity(asset) {
    await this.sync();
    const mine = this.notes.filter((n) => n.mint === asset.mint && n.fromDeposit);
    const all = this.deposits.filter((d) => d.mint === asset.mint);
    if (!mine.length) return { total: all.length, after: null, depositedAt: null };
    const last = mine.reduce((a, b) => (b.index > a.index ? b : a));
    const myIndexes = new Set(mine.map((n) => n.index));
    const after = all.filter((d) => d.index > last.index && !myIndexes.has(d.index)).length;
    return { total: all.length, after, depositedAt: last.time };
  }

  // -------------------------------------------------------------------------- sending

  async _buildTx(payer, instructions) {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    this._lastBlockhash = { blockhash, lastValidBlockHeight };
    const msg = new TransactionMessage({
      payerKey: new PublicKey(payer),
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), ...instructions],
    }).compileToV0Message(this.lookupTable ? [this.lookupTable] : []);
    return new VersionedTransaction(msg);
  }

  /** wallet: {publicKey, signTransaction(tx)} (wallet adapter / Keypair wrapper). */
  async _sendWithWallet(wallet, instructions, onStage) {
    const tx = await this._buildTx(wallet.publicKey, instructions);
    onStage?.("confirm");
    const signed = await wallet.signTransaction(tx);
    const raw = signed.serialize();
    // Wallets (e.g. Phantom) may swap in a fresher blockhash when the user approves; then our
    // expiry height no longer applies, so allow a full validity window from now instead.
    let expiry = this._lastBlockhash.lastValidBlockHeight;
    if (signed.message.recentBlockhash !== this._lastBlockhash.blockhash) {
      expiry = (await this.connection.getBlockHeight("confirmed")) + 150;
    }
    const sig = await this.connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 });
    onStage?.("pending", sig);
    await this._confirm(sig, raw, expiry);
    return sig;
  }

  /**
   * Waits for `signature` by polling getSignatureStatuses over HTTP (works on every RPC; many
   * public endpoints don't deliver WebSocket subscriptions). Re-broadcasts `raw` while waiting.
   * Before reporting expiry it checks the chain one last time, so a transaction that landed is
   * never reported as failed.
   */
  async _confirm(signature, raw, lastValidBlockHeight) {
    const statusOf = async () => {
      const { value } = await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      return value[0];
    };
    const settled = (st) => st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
    for (let tick = 0; ; tick++) {
      let st = null;
      try {
        st = await statusOf();
      } catch {
        /* transient RPC error: keep polling */
      }
      if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
      if (settled(st)) return;
      if (tick % 2 === 1 && raw) this.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      const height = await this.connection.getBlockHeight("confirmed").catch(() => 0);
      if (lastValidBlockHeight && height > lastValidBlockHeight) {
        await new Promise((r) => setTimeout(r, 3000));
        st = await statusOf().catch(() => null);
        if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
        if (st) return; // it landed after all
        throw new Error("The transaction expired before the network included it. Nothing was sent; please try again.");
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  async _sendWithRelayer(relayerUrl, payload, onStage) {
    onStage?.("relay");
    const body = JSON.stringify(payload, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Array.from(v) : v));
    const res = await fetch(relayerEndpoint(relayerUrl, "/relay"), { method: "POST", headers: { "content-type": "application/json" }, body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Relayer refused: ${json.error ?? res.status}`);
    onStage?.("pending", json.signature);
    await this._confirm(json.signature, null, json.lastValidBlockHeight ?? (await this.connection.getBlockHeight("confirmed")) + 150);
    return json.signature;
  }

  /** Shield exactly one listed deposit size. */
  async shield({ asset, amount, wallet, onStage, onProgress }) {
    amount = BigInt(amount);
    if (!denomsRaw(asset).includes(amount)) throw new Error(`${asset.symbol} deposits must be one of ${asset.denominations.join(" / ")}`);
    onStage?.("sync");
    await this.sync();
    const owner = wallet.publicKey;
    const depositorToken =
      asset.mint === NATIVE_SOL ? null : getAssociatedTokenAddressSync(new PublicKey(asset.mint), owner, false, new PublicKey(asset.tokenProgram));
    onStage?.("prove");
    const out = new Utxo({ amount, assetId: assetId(new PublicKey(asset.mint)), keypair: this.keypair });
    const args = await prepareTransaction({
      tree: this.tree, asset, outputs: [out], extAmount: amount, recipient: owner, relayer: owner, keypair: this.keypair, prove: this.prove, onProgress,
    });
    const ix = transactInstruction({ programId: this.P.programId, signer: owner, asset, recipient: owner, relayer: owner, depositorToken, args });
    const sig = await this._sendWithWallet(wallet, [ix], onStage);
    await this.sync();
    onStage?.("done", sig);
    return sig;
  }

  /** Accounts that receive a withdrawal: the wallet for SOL, its associated token account otherwise. */
  receivingAccount(asset, owner) {
    return asset.mint === NATIVE_SOL
      ? new PublicKey(owner)
      : getAssociatedTokenAddressSync(new PublicKey(asset.mint), new PublicKey(owner), true, new PublicKey(asset.tokenProgram));
  }

  /** Plan which notes a withdrawal spends, for review screens. */
  async plan({ asset, amount, fee = 0n }) {
    const utxos = await this.getUnspent(asset);
    const need = BigInt(amount) + BigInt(fee);
    const total = utxos.reduce((s, u) => s + u.amount, 0n);
    if (total < need) return { ok: false, total, need };
    // simulate unshield(): merge the two smallest notes until two notes cover the amount
    let amounts = utxos.map((u) => u.amount);
    let merges = 0;
    while (!pickInputs(amounts.map((a) => ({ amount: a })), need)) {
      const [x, y] = amounts.splice(-2);
      amounts.push(x + y);
      amounts.sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
      merges++;
    }
    const used = pickInputs(amounts.map((a) => ({ amount: a })), need);
    return { ok: true, total, need, merges, change: used.reduce((s, u) => s + u.amount, 0n) - need };
  }

  /**
   * Unshield any amount to `to` (a wallet address). Via a relayer when relayerUrl is set,
   * otherwise `wallet` pays gas and appears as the transaction signer.
   */
  async unshield({ asset, amount, to, wallet, relayerUrl, relayer, fee = 0n, mergeFee = 0n, onStage, onProgress }) {
    amount = BigInt(amount);
    fee = BigInt(fee);
    const need = amount + fee;
    const recipient = this.receivingAccount(asset, to);
    const feeAccount = relayer ? this.receivingAccount(asset, relayer) : recipient;
    const inputs = await this.spendable({ asset, need, wallet, relayerUrl, relayer, mergeFee, onStage, onProgress });
    onStage?.("prove");
    const id = assetId(new PublicKey(asset.mint));
    const change = new Utxo({ amount: inputs.reduce((s, u) => s + u.amount, 0n) - need, assetId: id, keypair: this.keypair });
    const args = await prepareTransaction({
      tree: this.tree, asset, inputs, outputs: [change], extAmount: -amount, fee, recipient, relayer: feeAccount, keypair: this.keypair, prove: this.prove, onProgress,
    });
    const sig = await this._submitSpend({ asset, args, recipient, feeAccount, to, wallet, relayerUrl, onStage });
    await this.sync();
    onStage?.("done", sig);
    return sig;
  }

  /**
   * At most two notes of `asset` that together cover `need`, merging the smallest notes
   * privately (through the relayer when set) until that's possible.
   */
  async spendable({ asset, need, wallet, relayerUrl, relayer, mergeFee = 0n, onStage, onProgress }) {
    need = BigInt(need);
    onStage?.("sync");
    for (;;) {
      const utxos = await this.getUnspent(asset);
      const total = utxos.reduce((s, u) => s + u.amount, 0n);
      if (total < need) throw new Error(`Not enough private ${asset.symbol}.`);
      const inputs = pickInputs(utxos, need);
      const id = assetId(new PublicKey(asset.mint));
      if (inputs) return inputs;
      onStage?.("merge");
      const pair = utxos.slice(-2);
      const merged = new Utxo({ amount: pair[0].amount + pair[1].amount - BigInt(mergeFee), assetId: id, keypair: this.keypair });
      // nothing leaves the pool, so recipient and fee account are both the account the relayer (or wallet) passes
      const sink = relayer ? this.receivingAccount(asset, relayer) : wallet.publicKey;
      const args = await prepareTransaction({
        tree: this.tree, asset, inputs: pair, outputs: [merged], fee: mergeFee, recipient: sink, relayer: sink, keypair: this.keypair, prove: this.prove, onProgress,
      });
      await this._submitSpend({ asset, args, recipient: sink, feeAccount: sink, to: null, wallet, relayerUrl, onStage });
      await this.sync();
    }
  }

  async _submitSpend({ asset, args, recipient, feeAccount, to, wallet, relayerUrl, onStage }) {
    if (relayerUrl) {
      return this._sendWithRelayer(relayerUrl, { mint: asset.mint, recipientOwner: to?.toString() ?? null, recipient: recipient.toString(), args }, onStage);
    }
    const signer = wallet.publicKey;
    const ixs = [];
    if (asset.mint !== NATIVE_SOL && to) {
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(signer, recipient, new PublicKey(to), new PublicKey(asset.mint), new PublicKey(asset.tokenProgram)));
    }
    ixs.push(transactInstruction({ programId: this.P.programId, signer, asset, recipient, relayer: feeAccount, args }));
    return this._sendWithWallet(wallet, ixs, onStage);
  }
}

/** Smallest single note that covers `need`, else the two largest if together they do, else null. */
function pickInputs(utxos, need) {
  const single = [...utxos].reverse().find((u) => u.amount >= need);
  if (single) return [single];
  if (utxos.length >= 2 && utxos[0].amount + utxos[1].amount >= need) return utxos.slice(0, 2);
  return null;
}

export { assetByMint };

// ---------------------------------------------------------------------------- admin cleanup

const adminDisc = (name) => sha256(new TextEncoder().encode(`global:${name}`)).subarray(0, 8);

/**
 * Admin: reclaim an asset's rent. Only succeeds once the asset has been paused for the close
 * delay and its vault is empty (no note holds value).
 */
export function closeAssetInstruction({ programId, admin, asset }) {
  const P = pdas(programId);
  const isSol = asset.mint === NATIVE_SOL;
  const ph = { pubkey: P.programId, isSigner: false, isWritable: false };
  return new TransactionInstruction({
    programId: P.programId,
    keys: [
      { pubkey: new PublicKey(admin), isSigner: true, isWritable: true },
      { pubkey: P.pool, isSigner: false, isWritable: true },
      { pubkey: P.asset(asset.mint), isSigner: false, isWritable: true },
      { pubkey: P.solVault, isSigner: false, isWritable: false },
      isSol ? ph : { pubkey: P.vault(asset), isSigner: false, isWritable: true },
      isSol ? ph : { pubkey: new PublicKey(asset.tokenProgram), isSigner: false, isWritable: false },
    ],
    data: Buffer.from(adminDisc("close_asset")),
  });
}

/** Admin: close the pool and SOL vault once every asset is closed. */
export function closePoolInstruction({ programId, admin }) {
  const P = pdas(programId);
  return new TransactionInstruction({
    programId: P.programId,
    keys: [
      { pubkey: new PublicKey(admin), isSigner: true, isWritable: true },
      { pubkey: P.pool, isSigner: false, isWritable: true },
      { pubkey: P.solVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(adminDisc("close_pool")),
  });
}
