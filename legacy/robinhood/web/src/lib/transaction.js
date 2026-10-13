// Browser port of src/lib/transaction.js (proof runs in prover.worker.js).
import { AbiCoder, keccak256, ZeroAddress } from "ethers";
import { FIELD_SIZE, Keypair, Utxo, toHex32, mod } from "./crypto.js";

const EXT_DATA_TYPE =
  "tuple(address recipient,int256 extAmount,address relayer,uint256 fee,address token,bytes encryptedOutput1,bytes encryptedOutput2)";

export function hashExtData(e) {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    [EXT_DATA_TYPE],
    [[e.recipient, e.extAmount, e.relayer, e.fee, e.token, e.encryptedOutput1, e.encryptedOutput2]],
  );
  return BigInt(keccak256(encoded)) % FIELD_SIZE;
}

let worker = null;
let nextId = 0;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./prover.worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      if (data.type === "progress") p.onProgress?.(data);
      else {
        pending.delete(data.id);
        data.type === "done" ? p.resolve(data.proof) : p.reject(new Error(data.error));
      }
    };
  }
  return worker;
}

/** Warm the worker + proving key download before the user clicks. */
export function preloadProver(onProgress) {
  return prove(null, onProgress).catch(() => {});
}

function prove(input, onProgress) {
  const id = nextId++;
  const stringify = (v) => (typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(stringify) : v);
  const plain = input && Object.fromEntries(Object.entries(input).map(([k, v]) => [k, stringify(v)]));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, input: plain });
  });
}

function encodeProof(proof) {
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

export async function prepareTransaction({
  tree, token, inputs = [], outputs = [], extAmount = 0n, fee = 0n,
  recipient = ZeroAddress, relayer = ZeroAddress, keypair, onProgress,
}) {
  const assetId = BigInt(token);
  inputs = [...inputs];
  outputs = [...outputs];
  while (inputs.length < 2) inputs.push(new Utxo({ assetId, keypair: new Keypair() }));
  while (outputs.length < 2) outputs.push(new Utxo({ assetId, keypair }));

  const inPathElements = [];
  const inPathIndices = [];
  for (const u of inputs) {
    if (u.amount > 0n) {
      if (tree.leaves[u.index] !== u.getCommitment()) throw new Error(`Note ${u.index} doesn't match the pool. Refresh and try again.`);
      inPathElements.push(tree.path(u.index).pathElements);
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
    encryptedOutput1: await outputs[0].encrypt(),
    encryptedOutput2: await outputs[1].encrypt(),
  };
  const extDataHash = hashExtData(extData);
  const publicAmount = mod(BigInt(extAmount) - BigInt(fee));

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

  const proof = await prove(input, onProgress);
  return {
    args: {
      proof: encodeProof(proof),
      root: toHex32(input.root),
      inputNullifiers: input.inputNullifier.map(toHex32),
      outputCommitments: input.outputCommitment.map(toHex32),
      publicAmount,
      extDataHash: toHex32(extDataHash),
    },
    extData,
  };
}
