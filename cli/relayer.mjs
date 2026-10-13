#!/usr/bin/env node
// Vanish relayer as a standalone HTTP server (the same logic also runs as Vercel functions in api/).
//   RELAYER_KEYPAIR=keys/relayer.json RPC_URL=... PORT=8000 FEE_BPS=30 [JUP_API_KEY=...] node cli/relayer.mjs
// Routes: GET /info, /token?mint=, /quote?... ; POST /relay, /swap, /buy
import http from "http";
import { PROGRAM_ID, handle, relayerAddress } from "./relayer-core.mjs";

const PORT = Number(process.env.PORT ?? 8000);
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };

http
  .createServer(async (req, res) => {
    if (req.method === "OPTIONS") return res.writeHead(204, CORS), res.end();
    const url = new URL(req.url, "http://x");
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 32 * 1024) {
        res.writeHead(413, { "content-type": "application/json", ...CORS });
        return res.end(JSON.stringify({ error: "body too large" }));
      }
    }
    const [status, json] = await handle(url.pathname.replace(/^\/+/, ""), { method: req.method, query: Object.fromEntries(url.searchParams), body });
    res.writeHead(status, { "content-type": "application/json", ...CORS });
    res.end(JSON.stringify(json));
  })
  .listen(PORT, () => console.log(`relayer ${relayerAddress.toBase58()} for ${PROGRAM_ID.toBase58()} on :${PORT}`));
