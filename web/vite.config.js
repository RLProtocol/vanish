import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // "buffer/" forces the npm package instead of Vite's empty stub for the Node builtin
    alias: { sdk: path.resolve(__dirname, "../sdk"), buffer: "buffer/" },
    // the shared SDK lives outside web/; make it use web's copies so PublicKey etc. are the same class
    dedupe: ["@solana/web3.js", "@solana/spl-token", "buffer", "poseidon-lite", "@noble/hashes", "snarkjs"],
  },
  server: { fs: { allow: [".."] } },
  define: { "process.env": {}, global: "globalThis" },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 3000 },
  optimizeDeps: { esbuildOptions: { target: "es2022" }, include: ["buffer"] },
});
