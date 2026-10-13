// Vercel function: GET /api/quote (logic in cli/relayer-core.mjs)
import { handle } from "../cli/relayer-core.mjs";

export default async function handler(req, res) {
  const [status, json] = await handle("quote", { method: req.method, query: req.query, body: req.body });
  res.status(status).json(json);
}
