// Solana's JS libraries expect Node's Buffer as a global. Imported first in main.jsx so it
// exists before @solana/web3.js and @solana/spl-token evaluate.
import { Buffer } from "buffer";

if (!globalThis.Buffer) globalThis.Buffer = Buffer;
if (!globalThis.process) globalThis.process = { env: {} };
