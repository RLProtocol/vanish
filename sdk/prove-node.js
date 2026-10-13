// Node prover: runs snarkjs against the circuit artifacts in build/circuits.
import path from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { stringifyInput } from "./solmix.js";

const BUILD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "build", "circuits");
export const WASM = path.join(BUILD, "transaction_js", "transaction.wasm");
export const ZKEY = path.join(BUILD, "transaction.zkey");

export async function proveNode(input) {
  const { proof } = await snarkjs.groth16.fullProve(stringifyInput(input), WASM, ZKEY);
  return proof;
}
