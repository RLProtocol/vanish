// Vercel function: GET /api/token (logic in cli/relayer-core.mjs)
import { handle } from "../cli/relayer-core.mjs";

export default async function handler(req, res) {
  const [status, json] = await handle("token", { method: req.method, query: req.query, body: req.body });
  res.status(status).json(json);
}
