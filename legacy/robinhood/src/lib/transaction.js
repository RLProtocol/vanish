const path = require("path");
const snarkjs = require("snarkjs");
const { AbiCoder, keccak256, ZeroAddress } = require("ethers");
const { FIELD_SIZE, Keypair, Utxo, toHex32, mod } = require("./crypto");

const BUILD = path.join(__dirname, "..", "..", "build", "circuits");
const WASM = path.join(BUILD, "transaction_js", "transaction.wasm");
const ZKEY = path.join(BUILD, "transaction.zkey");
const N_INS = 2;
const N_OUTS = 2;

const EXT_DATA_TYPE = "tuple(address recipient,int256 extAmount,address relayer,uint256 fee,address token,bytes encryptedOutput1,bytes encryptedOutput2)";

function hashExtData(ext) {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    [EXT_DATA_TYPE],
    [[ext.recipient, ext.extAmount, ext.relayer, ext.fee, ext.token, ext.encryptedOutput1, ext.encryptedOutput2]],
  );
  return BigInt(keccak256(encoded)) % FIELD_SIZE;
}

async function prove(input) {
  const { proof } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  // snarkjs -> Solidity: G2 coordinates are swapped.
  return AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]"],
    [
      [proof.pi_a[0], proof.pi_a[1]],
      [
        [proof.pi_b[0][1], proof.pi_b[0][0]],
        [proof.pi_b[1][1], proof.pi_b[1][0]],
      ],
      [proof.pi_c[0], proof.pi_c[1]],
    ],
  );
}

/**
 * Builds and proves a pool transaction.
 * @param tree      MerkleTree synced with the pool
 * @param token     asset address (ZeroAddress for ETH)
 * @param inputs    Utxos being spent (0..2, must have .index)
 * @param outputs   Utxos being created (0..2)
 * @param extAmount >0 deposit, <0 withdrawal, 0 internal
 */
async function prepareTransaction({ tree, token, inputs = [], outputs = [], extAmount = 0n, fee = 0n, recipient = ZeroAddress, relayer = ZeroAddress, keypair }) {
  if (inputs.length > N_INS || outputs.length > N_OUTS) throw new Error("too many inputs/outputs");
  const assetId = BigInt(token);
  for (const u of [...inputs, ...outputs]) {
    if (u.assetId !== assetId) throw new Error("utxo asset mismatch");
  }

  inputs = [...inputs];
  outputs = [...outputs];
  while (inputs.length < N_INS) inputs.push(new Utxo({ assetId, keypair: new Keypair() }));
  while (outputs.length < N_OUTS) outputs.push(new Utxo({ assetId, keypair: keypair ?? new Keypair() }));

  const inPathElements = [];
  const inPathIndices = [];
  for (const u of inputs) {
    if (u.amount > 0n) {
      if (u.index === null || u.index === undefined) throw new Error("input utxo has no index");
      if (tree.leaves[u.index] !== u.getCommitment()) throw new Error(`commitment mismatch at leaf ${u.index}`);
      const p = tree.path(u.index);
      inPathElements.push(p.pathElements);
      inPathIndices.push(u.index);
    } else {
      inPathElements.push(new Array(tree.levels).fill(0n));
      inPathIndices.push(0);
    }
  }

  const extData = {
    recipient,
    extAmount: BigInt(extAmount),
    relayer,
    fee: BigInt(fee),
    token,
    encryptedOutput1: outputs[0].encrypt(),
    encryptedOutput2: outputs[1].encrypt(),
  };
  const extDataHash = hashExtData(extData);
  const publicAmount = mod(BigInt(extAmount) - BigInt(fee));

  const sumIn = inputs.reduce((s, u) => s + u.amount, 0n);
  const sumOut = outputs.reduce((s, u) => s + u.amount, 0n);
  if (mod(sumIn + publicAmount) !== mod(sumOut)) throw new Error("inputs + publicAmount != outputs");

  const input = {
    root: tree.root,
    publicAmount,
    extDataHash,
    assetId,
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

  const proof = await prove(input);
  const args = {
    proof,
    root: toHex32(input.root),
    inputNullifiers: input.inputNullifier.map(toHex32),
    outputCommitments: input.outputCommitment.map(toHex32),
    publicAmount: publicAmount,
    extDataHash: toHex32(extDataHash),
  };
  return { args, extData, outputs };
}

module.exports = { prepareTransaction, hashExtData, EXT_DATA_TYPE };
