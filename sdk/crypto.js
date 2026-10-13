// Keys, notes and note encryption. Runs unchanged in Node (>= 20) and browsers (WebCrypto).
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { poseidon4 } from "poseidon-lite/poseidon4";

export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const HASHERS = [null, poseidon1, poseidon2, poseidon3, poseidon4];
export const poseidonHash = (items) => HASHERS[items.length](items.map((x) => BigInt(x)));

export const mod = (n) => ((BigInt(n) % FIELD_SIZE) + FIELD_SIZE) % FIELD_SIZE;
export const toBytes32 = (n) => {
  const hex = BigInt(n).toString(16).padStart(64, "0");
  return Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
};
export const fromBytes = (b) => BigInt("0x" + (Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("") || "0"));
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function randomField() {
  return fromBytes(crypto.getRandomValues(new Uint8Array(31)));
}

/** Shielded keypair: pubkey = Poseidon(privkey); notes are AES-GCM encrypted under a key derived from privkey. */
export class Keypair {
  constructor(privkey = randomField()) {
    this.privkey = BigInt(privkey);
    this.pubkey = poseidonHash([this.privkey]);
    this._aes = null;
  }

  async aesKey() {
    if (!this._aes) {
      const material = new TextEncoder().encode("solmix-note-key:" + this.privkey.toString(16).padStart(64, "0"));
      const digest = await crypto.subtle.digest("SHA-256", material);
      this._aes = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
    }
    return this._aes;
  }

  /** 68 bytes: iv(12) | tag(16) | ciphertext of amount u64 BE (8) | blinding (32). */
  async encrypt(amount, blinding) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = new Uint8Array(40);
    new DataView(pt.buffer).setBigUint64(0, BigInt(amount));
    pt.set(toBytes32(blinding), 8);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, await this.aesKey(), pt));
    const out = new Uint8Array(68);
    out.set(iv, 0);
    out.set(sealed.subarray(40), 12); // tag
    out.set(sealed.subarray(0, 40), 28); // ciphertext
    return out;
  }

  /** {amount, blinding} or null when the note belongs to someone else. */
  async decrypt(bytes) {
    if (bytes.length !== 68) return null;
    try {
      const sealed = new Uint8Array(56);
      sealed.set(bytes.subarray(28), 0);
      sealed.set(bytes.subarray(12, 28), 40);
      const pt = new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12), tagLength: 128 }, await this.aesKey(), sealed),
      );
      return { amount: new DataView(pt.buffer).getBigUint64(0), blinding: fromBytes(pt.subarray(8)) };
    } catch {
      return null;
    }
  }

  toString() {
    return "0x" + this.privkey.toString(16);
  }
}

/** A note. assetId is derived from the mint (see assetId()). */
export class Utxo {
  constructor({ amount = 0n, keypair = new Keypair(), blinding = randomField(), assetId = 0n, index = null } = {}) {
    this.amount = BigInt(amount);
    this.keypair = keypair;
    this.blinding = BigInt(blinding);
    this.assetId = BigInt(assetId);
    this.index = index;
  }

  getCommitment() {
    return poseidonHash([this.amount, this.keypair.pubkey, this.blinding, this.assetId]);
  }

  getNullifier() {
    const index = this.index ?? 0;
    const commitment = this.getCommitment();
    const signature = poseidonHash([this.keypair.privkey, commitment, index]);
    return poseidonHash([commitment, index, signature]);
  }

  encrypt() {
    return this.keypair.encrypt(this.amount, this.blinding);
  }
}

/** Mirrors the program: first 31 bytes of the mint as a big-endian number (native SOL = 0). */
export function assetId(mintPublicKey) {
  return fromBytes(mintPublicKey.toBytes().subarray(0, 31));
}

export { toHex };
