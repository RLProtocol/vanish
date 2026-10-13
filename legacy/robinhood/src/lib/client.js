const fs = require("fs");
const { ZeroAddress, Contract } = require("ethers");
const { Utxo, toHex32 } = require("./crypto");
const { MerkleTree } = require("./merkleTree");
const { prepareTransaction } = require("./transaction");

const POOL_ABI = [
  "function transact((bytes proof,bytes32 root,bytes32[2] inputNullifiers,bytes32[2] outputCommitments,uint256 publicAmount,bytes32 extDataHash) args,(address recipient,int256 extAmount,address relayer,uint256 fee,address token,bytes encryptedOutput1,bytes encryptedOutput2) extData) payable",
  "function levels() view returns (uint32)",
  "function nextIndex() view returns (uint32)",
  "function getLastRoot() view returns (bytes32)",
  "function isSpent(bytes32) view returns (bool)",
  "function getAssets() view returns (address[])",
  "function getDenominations(address) view returns (uint256[])",
  "function isDenomination(address,uint256) view returns (bool)",
  "event NewCommitment(bytes32 commitment, uint256 index, bytes encryptedOutput)",
  "event NewNullifier(bytes32 nullifier)",
];
const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

/** Serialize bigint-bearing tx payloads to JSON (used by the relayer protocol). */
const toJson = (obj) => JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v));

class RobinMixClient {
  /**
   * @param poolAddress  deployed RobinMix address
   * @param runner       ethers provider or signer (signer needed for direct submission)
   * @param keypair      shielded Keypair
   * @param deployBlock  first block to scan
   * @param cacheFile    optional JSON path to persist the scanned tree/notes
   */
  constructor({ poolAddress, runner, keypair, deployBlock = 0, cacheFile = null, logChunk = 50000 }) {
    this.pool = new Contract(poolAddress, POOL_ABI, runner);
    this.runner = runner;
    this.provider = runner.provider ?? runner;
    this.keypair = keypair;
    this.deployBlock = deployBlock;
    this.cacheFile = cacheFile;
    this.logChunk = logChunk;
    this.lastBlock = deployBlock - 1;
    this.notes = []; // {index, amount, blinding, assetId}
    this.tree = null;
  }

  async _init() {
    if (this.tree) return;
    this.levels = Number(await this.pool.levels());
    let leaves = [];
    if (this.cacheFile && fs.existsSync(this.cacheFile)) {
      const c = JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
      this.lastBlock = c.lastBlock;
      leaves = c.leaves.map(BigInt);
      this.notes = c.notes.map((n) => ({ index: n.index, amount: BigInt(n.amount), blinding: BigInt(n.blinding), assetId: BigInt(n.assetId) }));
    }
    this.tree = new MerkleTree(this.levels, leaves);
  }

  _save() {
    if (!this.cacheFile) return;
    fs.writeFileSync(
      this.cacheFile,
      toJson({ lastBlock: this.lastBlock, leaves: this.tree.leaves.map(toHex32), notes: this.notes }),
    );
  }

  /** Pulls new commitments, rebuilds the tree and discovers notes encrypted to our key. */
  async sync(minBlock = 0) {
    await this._init();
    // raw eth_blockNumber: ethers caches getBlockNumber()/"latest", which would miss a just-mined tx
    const latest = Math.max(Number(await this.provider.send("eth_blockNumber", [])), minBlock, this.lastBlock);
    const filter = this.pool.filters.NewCommitment();
    let from = this.lastBlock + 1;
    let chunk = this.logChunk;
    const events = [];
    while (from <= latest) {
      const to = Math.min(from + chunk - 1, latest);
      try {
        events.push(...(await this.pool.queryFilter(filter, from, to)));
        from = to + 1;
      } catch (e) {
        if (chunk <= 100) throw e;
        chunk = Math.floor(chunk / 2);
      }
    }
    events.sort((a, b) => Number(a.args.index) - Number(b.args.index));

    const newLeaves = [];
    for (const ev of events) {
      const index = Number(ev.args.index);
      const expected = this.tree.leaves.length + newLeaves.length;
      if (index < expected) continue; // already have it
      if (index !== expected) throw new Error(`missing leaf ${expected} (got ${index}); clear the cache and resync`);
      const commitment = BigInt(ev.args.commitment);
      newLeaves.push(commitment);

      const dec = this.keypair.decrypt(ev.args.encryptedOutput);
      if (dec && dec.amount > 0n) {
        const utxo = new Utxo({ ...dec, keypair: this.keypair, index });
        if (utxo.getCommitment() === commitment) this.notes.push({ index, ...dec });
      }
    }
    if (newLeaves.length) this.tree.bulkInsert(newLeaves);

    // compare at the same block we scanned up to, so concurrent txs can't cause false alarms
    const onchainRoot = BigInt(await this.pool.getLastRoot({ blockTag: latest }));
    if (onchainRoot !== this.tree.root) throw new Error("local tree root differs from on-chain root; delete the cache and resync");
    this.lastBlock = latest;
    this._save();
  }

  _toUtxo(n) {
    return new Utxo({ amount: n.amount, blinding: n.blinding, assetId: n.assetId, keypair: this.keypair, index: n.index });
  }

  /** Unspent notes for `token`, largest first. */
  async getUnspent(token) {
    await this.sync();
    const assetId = BigInt(token);
    const mine = this.notes.filter((n) => n.assetId === assetId).map((n) => this._toUtxo(n));
    const spent = await Promise.all(mine.map((u) => this.pool.isSpent(toHex32(u.getNullifier()))));
    return mine.filter((_, i) => !spent[i]).sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  }

  async balance(token) {
    const utxos = await this.getUnspent(token);
    return { total: utxos.reduce((s, u) => s + u.amount, 0n), notes: utxos.length };
  }

  async _submit({ args, extData }, { signer, relayerUrl, value = 0n }) {
    if (relayerUrl) {
      const res = await fetch(new URL("/relay", relayerUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: toJson({ args, extData }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`relayer: ${body.error ?? res.status}`);
      const receipt = await this.provider.waitForTransaction(body.txHash);
      if (receipt.status !== 1) throw new Error(`relayed tx ${body.txHash} reverted`);
      return receipt;
    }
    const tx = await this.pool.connect(signer).transact(args, extData, { value });
    return tx.wait();
  }

  /** Deposit exactly one registered denomination. */
  async deposit({ token, amount, signer }) {
    amount = BigInt(amount);
    if (!(await this.pool.isDenomination(token, amount))) {
      const allowed = (await this.pool.getDenominations(token)).map(String).join(", ");
      throw new Error(`${amount} is not an allowed denomination (allowed raw units: ${allowed})`);
    }
    await this.sync();
    if (token !== ZeroAddress) {
      const erc20 = new Contract(token, ERC20_ABI, signer);
      const owner = await signer.getAddress();
      if ((await erc20.allowance(owner, await this.pool.getAddress())) < amount) {
        await (await erc20.approve(await this.pool.getAddress(), amount)).wait();
      }
    }
    const output = new Utxo({ amount, assetId: BigInt(token), keypair: this.keypair });
    const tx = await prepareTransaction({ tree: this.tree, token, outputs: [output], extAmount: amount, keypair: this.keypair });
    const receipt = await this._submit(tx, { signer, value: token === ZeroAddress ? amount : 0n });
    await this.sync(receipt.blockNumber);
    return receipt;
  }

  /** Private merge of our two smallest notes (no funds leave the pool). */
  async merge({ token, signer, relayerUrl, relayer = ZeroAddress, fee = 0n }) {
    const utxos = await this.getUnspent(token);
    if (utxos.length < 2) throw new Error("need at least two notes to merge");
    const inputs = utxos.slice(-2);
    const total = inputs[0].amount + inputs[1].amount - BigInt(fee);
    const out = new Utxo({ amount: total, assetId: BigInt(token), keypair: this.keypair });
    const tx = await prepareTransaction({ tree: this.tree, token, inputs, outputs: [out], fee, relayer, keypair: this.keypair });
    const receipt = await this._submit(tx, { signer, relayerUrl });
    await this.sync(receipt.blockNumber);
    return receipt;
  }

  /**
   * Withdraw any amount. Spends up to two notes; leftover becomes a private change
   * note. If more than two notes are needed, notes are merged privately first.
   */
  async withdraw({ token, amount, recipient, signer, relayerUrl, relayer = ZeroAddress, fee = 0n, mergeFee = 0n, onMerge }) {
    amount = BigInt(amount);
    fee = BigInt(fee);
    if (amount <= 0n) throw new Error("amount must be positive");
    const need = amount + fee;

    for (;;) {
      const utxos = await this.getUnspent(token);
      const total = utxos.reduce((s, u) => s + u.amount, 0n);
      if (total < need) throw new Error(`insufficient shielded balance: have ${total}, need ${need}`);

      const single = [...utxos].reverse().find((u) => u.amount >= need); // smallest single note that covers it
      let inputs = single ? [single] : null;
      if (!inputs && utxos[0].amount + (utxos[1]?.amount ?? 0n) >= need) inputs = utxos.slice(0, 2);

      if (inputs) {
        const change = inputs.reduce((s, u) => s + u.amount, 0n) - need;
        const out = new Utxo({ amount: change, assetId: BigInt(token), keypair: this.keypair });
        const tx = await prepareTransaction({
          tree: this.tree, token, inputs, outputs: [out], extAmount: -amount, fee, recipient, relayer, keypair: this.keypair,
        });
        const receipt = await this._submit(tx, { signer, relayerUrl });
        await this.sync(receipt.blockNumber);
        return receipt;
      }

      onMerge?.();
      await this.merge({ token, signer, relayerUrl, relayer, fee: mergeFee });
    }
  }
}

module.exports = { RobinMixClient, POOL_ABI, ERC20_ABI, toJson };
