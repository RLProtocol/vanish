// Browser port of src/lib/crypto.js. Byte-compatible with the CLI:
// same Poseidon hashes, same AES-256-GCM note format iv(12) | tag(16) | ct(96).
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { poseidon4 } from "poseidon-lite/poseidon4";

export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const HASHERS = [null, poseidon1, poseidon2, poseidon3, poseidon4];
export const poseidonHash = (items) => HASHERS[items.length](items.map((x) => BigInt(x)));

export const toHex32 = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
export const mod = (n) => ((BigInt(n) % FIELD_SIZE) + FIELD_SIZE) % FIELD_SIZE;

const hexToBytes = (hex) => Uint8Array.from(hex.replace(/^0x/, "").match(/../g).map((b) => parseInt(b, 16)));
const bytesToHex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function randomField() {
  return BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(31))));
}

export class Keypair {
  constructor(privkey = randomField()) {
    this.privkey = BigInt(privkey);
    this.pubkey = poseidonHash([this.privkey]);
    this._key = null;
  }

  async _aes() {
    if (!this._key) {
      const material = new TextEncoder().encode("robinmix-note-key" + toHex32(this.privkey));
      const digest = await crypto.subtle.digest("SHA-256", material);
      this._key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
    }
    return this._key;
  }

  async encrypt(amount, blinding, assetId) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = hexToBytes([amount, blinding, assetId].map((x) => toHex32(x).slice(2)).join(""));
    const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, await this._aes(), pt));
    const ct = out.subarray(0, out.length - 16);
    const tag = out.subarray(out.length - 16);
    return bytesToHex(new Uint8Array([...iv, ...tag, ...ct]));
  }

  /** {amount, blinding, assetId} or null if the note isn't ours. */
  async decrypt(hex) {
    const buf = hexToBytes(hex);
    if (buf.length !== 124) return null;
    try {
      const iv = buf.subarray(0, 12);
      const sealed = new Uint8Array([...buf.subarray(28), ...buf.subarray(12, 28)]); // WebCrypto wants ct | tag
      const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, await this._aes(), sealed));
      const word = (i) => BigInt(bytesToHex(pt.subarray(i * 32, i * 32 + 32)));
      return { amount: word(0), blinding: word(1), assetId: word(2) };
    } catch {
      return null;
    }
  }
}

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
    return this.keypair.encrypt(this.amount, this.blinding, this.assetId);
  }
}
