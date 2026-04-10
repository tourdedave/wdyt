import http from "node:http";

import { DEFAULT_SERVER_URL, EXTENSION_ID } from "../shared/constants.js";
import { ensureDataDir } from "../shared/fs.js";
import type { EndRunRequest, StartRunRequest } from "../shared/types.js";
import { validateIngestPayload } from "../shared/validation.js";
import { persistRun } from "./storage.js";
import { bindRun, buildRunInfoForIngest, getBoundRun, markRunIngested, requestRunEnd, startRun } from "./state.js";

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

function writeJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function getServerUrl(req: http.IncomingMessage) {
  const host = req.headers.host;
  return host ? `http://${host}` : DEFAULT_SERVER_URL;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/runs/start") {
    try {
      const body = (await readJsonBody(req)) as StartRunRequest | null;

      if (!body || typeof body.suiteName !== "string" || typeof body.testName !== "string") {
        writeJson(res, 400, { error: "Invalid start run payload" });
        return;
      }

      const started = startRun(body);
      const serverUrl = getServerUrl(req);
      const bootstrapUrl =
        `chrome-extension://${EXTENSION_ID}/bootstrap.html` +
        `?serverUrl=${encodeURIComponent(serverUrl)}` +
        `&runId=${encodeURIComponent(started.runId)}`;

      writeJson(res, 201, {
        runId: started.runId,
        bootstrapUrl,
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      writeJson(res, 500, { error: message });
      return;
    }
  }

  if (req.method === "POST" && req.url === "/bindings/bind") {
    try {
      const body = (await readJsonBody(req)) as { runId?: string; browserSessionId?: string } | null;

      if (!body || typeof body.runId !== "string" || typeof body.browserSessionId !== "string") {
        writeJson(res, 400, { error: "Invalid bind payload" });
        return;
      }

      const binding = bindRun({
        runId: body.runId,
        browserSessionId: body.browserSessionId,
      });

      if (!binding) {
        writeJson(res, 404, { error: "Run not found" });
        return;
      }

      writeJson(res, 200, { ok: true, ...binding });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      writeJson(res, 409, { error: message });
      return;
    }
  }

  if (req.method === "GET" && req.url?.startsWith("/bindings/current")) {
    const requestUrl = new URL(req.url, getServerUrl(req));
    const browserSessionId = requestUrl.searchParams.get("browserSessionId");

    if (!browserSessionId) {
      writeJson(res, 400, { error: "browserSessionId is required" });
      return;
    }

    const binding = getBoundRun(browserSessionId);
    writeJson(res, 200, binding ? { bound: true, ...binding } : { bound: false });
    return;
  }

  if (req.method === "POST" && req.url === "/runs/end") {
    try {
      const body = (await readJsonBody(req)) as EndRunRequest | null;
      const reason = body?.reason ?? "completed";

      if (!body || typeof body.runId !== "string" || (reason !== "completed" && reason !== "timeout")) {
        writeJson(res, 400, { error: "Invalid end run payload" });
        return;
      }

      const ended = requestRunEnd({
        runId: body.runId,
        reason,
      });

      if (!ended) {
        writeJson(res, 404, { error: "Run not found" });
        return;
      }

      writeJson(res, 200, ended);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      writeJson(res, 500, { error: message });
      return;
    }
  }

  if (req.method === "POST" && req.url === "/ingest") {
    try {
      const body = await readJsonBody(req);

      if (!validateIngestPayload(body)) {
        writeJson(res, 400, { error: "Invalid ingest payload" });
        return;
      }

      const runInfo = buildRunInfoForIngest(body.run.id, body.run.endedAt, body.run.reason);

      if (!runInfo) {
        writeJson(res, 404, { error: "Run not found for ingest" });
        return;
      }

      const processed = await persistRun({
        suite: body.suite,
        run: runInfo,
        events: body.events,
      });
      markRunIngested(runInfo.id, runInfo.endedAt, runInfo.reason);

      writeJson(res, 202, { ok: true, flowId: processed.flowId });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      writeJson(res, 500, { error: message });
      return;
    }
  }

  if (req.method === "GET" && req.url === "/health") {
    writeJson(res, 200, { ok: true });
    return;
  }

  writeJson(res, 404, { error: "Not found" });
});

await ensureDataDir();

server.listen(PORT, HOST, () => {
  console.log(`WDIT server listening on http://${HOST}:${PORT}`);
});
