const { poseidonHash } = require("./crypto");

/** Sparse Poseidon Merkle tree matching MerkleTreeWithHistory.sol (empty leaf = 0). */
class MerkleTree {
  constructor(levels, leaves = []) {
    this.levels = levels;
    this.zeros = [0n];
    for (let i = 1; i <= levels; i++) this.zeros[i] = poseidonHash([this.zeros[i - 1], this.zeros[i - 1]]);
    this.layers = [leaves.map(BigInt)];
    for (let level = 1; level <= levels; level++) this.layers[level] = [];
    this._rebuild(0);
  }

  // Recomputes only the nodes at or after leaf `from` (leaves are append-only).
  _rebuild(from) {
    for (let level = 1; level <= this.levels; level++) {
      const below = this.layers[level - 1];
      const layer = this.layers[level];
      const start = from >> level;
      layer.length = start;
      for (let i = start; i < Math.ceil(below.length / 2); i++) {
        const left = below[2 * i];
        const right = 2 * i + 1 < below.length ? below[2 * i + 1] : this.zeros[level - 1];
        layer.push(poseidonHash([left, right]));
      }
    }
  }

  get root() {
    return this.layers[this.levels][0] ?? this.zeros[this.levels];
  }

  get leaves() {
    return this.layers[0];
  }

  bulkInsert(leaves) {
    const from = this.layers[0].length;
    this.layers[0].push(...leaves.map(BigInt));
    this._rebuild(from);
  }

  path(index) {
    if (index < 0 || index >= this.layers[0].length) throw new Error(`leaf ${index} not in tree`);
    const pathElements = [];
    let i = index;
    for (let level = 0; level < this.levels; level++) {
      const sibling = i ^ 1;
      pathElements.push(sibling < this.layers[level].length ? this.layers[level][sibling] : this.zeros[level]);
      i >>= 1;
    }
    return { pathElements, pathIndices: index };
  }
}

module.exports = { MerkleTree };
