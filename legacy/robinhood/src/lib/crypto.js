const crypto = require("crypto");
const { buildPoseidon } = require("circomlibjs");

const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let _poseidon;
async function initPoseidon() {
  if (!_poseidon) _poseidon = await buildPoseidon();
  return _poseidon;
}

function poseidonHash(items) {
  if (!_poseidon) throw new Error("call initPoseidon() first");
  return _poseidon.F.toObject(_poseidon(items.map((x) => BigInt(x))));
}

const randomField = () => BigInt("0x" + crypto.randomBytes(31).toString("hex"));
const toHex32 = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const mod = (n) => ((BigInt(n) % FIELD_SIZE) + FIELD_SIZE) % FIELD_SIZE;

/** Shielded keypair. pubkey = Poseidon(privkey); an AES key derived from privkey encrypts your notes. */
class Keypair {
  constructor(privkey = randomField()) {
    this.privkey = BigInt(privkey);
    this.pubkey = poseidonHash([this.privkey]);
    this.encKey = crypto.createHash("sha256").update("robinmix-note-key").update(toHex32(this.privkey)).digest();
  }

  // Note plaintext: amount(32) | blinding(32) | assetId(32). AES-256-GCM: iv(12) | tag(16) | ct(96)
  encrypt(amount, blinding, assetId) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.encKey, iv);
    const pt = Buffer.concat([amount, blinding, assetId].map((x) => Buffer.from(toHex32(x).slice(2), "hex")));
    const ct = Buffer.concat([c.update(pt), c.final()]);
    return "0x" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("hex");
  }

  /** Returns {amount, blinding, assetId} or null if this note isn't ours. */
  decrypt(hex) {
    try {
      const buf = Buffer.from(hex.replace(/^0x/, ""), "hex");
      if (buf.length !== 124) return null;
      const d = crypto.createDecipheriv("aes-256-gcm", this.encKey, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      const pt = Buffer.concat([d.update(buf.subarray(28)), d.final()]);
      const word = (i) => BigInt("0x" + pt.subarray(i * 32, i * 32 + 32).toString("hex"));
      return { amount: word(0), blinding: word(1), assetId: word(2) };
    } catch {
      return null;
    }
  }
}

/** A shielded note. assetId = uint160(token address); ETH is 0. */
class Utxo {
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

const assetIdOf = (token) => BigInt(token);

module.exports = { FIELD_SIZE, initPoseidon, poseidonHash, randomField, toHex32, mod, Keypair, Utxo, assetIdOf };
