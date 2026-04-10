import http from "node:http";

import { ensureDataDir } from "../shared/fs.js";
import { validateIngestPayload } from "../shared/validation.js";
import { persistRun } from "./storage.js";

const HOST = process.env.WDIT_HOST ?? "127.0.0.1";
const PORT = Number(process.env.WDIT_PORT ?? "3876");

async function readJsonBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody.length === 0 ? null : JSON.parse(rawBody);
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/ingest") {
    try {
      const body = await readJsonBody(req);

      if (!validateIngestPayload(body)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid ingest payload" }));
        return;
      }

      const processed = await persistRun(body);

      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, flowId: processed.flowId }));
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
      return;
    }
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

await ensureDataDir();

server.listen(PORT, HOST, () => {
  console.log(`WDIT server listening on http://${HOST}:${PORT}`);
});
