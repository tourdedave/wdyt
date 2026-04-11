import http from "node:http";

import { DEFAULT_SERVER_URL } from "../shared/constants.js";
import { ensureDataDir, getVocabularyPath, readJsonFile } from "../shared/fs.js";
import type { BrowserInfo, EndRunRequest, StartRunRequest } from "../shared/types.js";
import { validateIngestPayload } from "../shared/validation.js";
import { loadReviewUnits, refreshReviewUnits, saveReviewDecision, upsertVocabulary } from "./review.js";
import { persistRun } from "./storage.js";
import { bindRun, buildRunInfoForIngest, getBoundRun, markRunIngested, requestRunEnd, startRun, updateRunEnvironment } from "./state.js";

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

function renderBootstrapPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>WDIT Bootstrap</title>
    <style>
      body {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        padding: 24px;
      }
      #status[data-status="ok"] {
        color: #0a7d21;
      }
      #status[data-status="error"] {
        color: #b42318;
      }
    </style>
  </head>
  <body>
    <h1 id="status">WDIT initializing</h1>
    <pre id="details"></pre>
    <script>
      const statusEl = document.getElementById("status");
      const detailsEl = document.getElementById("details");
      const params = new URLSearchParams(window.location.search);
      const runId = params.get("runId");
      const serverUrl = params.get("serverUrl");

      const setStatus = (status, message) => {
        statusEl.textContent = message;
        statusEl.setAttribute("data-status", status);
      };

      const setDetails = (message) => {
        detailsEl.textContent = message;
      };

      let resolved = false;

      const finish = (status, message, details) => {
        resolved = true;
        setStatus(status, message);
        if (details) {
          setDetails(details);
        }
      };

      if (!runId || !serverUrl) {
        finish("error", "Missing bootstrap parameters");
      } else {
        const timeoutId = setTimeout(() => {
          if (!resolved) {
            finish("error", "WDIT bind timed out", "No response from content script bridge");
          }
        }, 5000);

        const bindIntervalId = setInterval(() => {
          if (resolved) {
            clearInterval(bindIntervalId);
            return;
          }

          window.postMessage(
            {
              kind: "WDIT_BIND_RUN",
              runId,
              serverUrl
            },
            "*"
          );
        }, 250);

        window.addEventListener("message", (event) => {
          if (event.source !== window || !event.data || event.data.kind !== "WDIT_BIND_RESULT") {
            return;
          }

          if (event.data.ok) {
            clearTimeout(timeoutId);
            clearInterval(bindIntervalId);
            finish("ok", "WDIT bound", \`runId=\${runId} browserSessionId=\${event.data.browserSessionId}\`);
            return;
          }

          clearTimeout(timeoutId);
          clearInterval(bindIntervalId);
          finish("error", "WDIT bind failed", event.data.error || "Unknown error");
        });
      }
    </script>
  </body>
</html>`;
}

function renderReviewPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>WDIT Review</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f1e7;
        --panel: #fffdf8;
        --line: #d8cfbf;
        --ink: #1d1a16;
        --muted: #6d6458;
        --accent: #1f6f4a;
        --accent-2: #8a5a18;
        --danger: #9f1d1d;
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Iowan Old Style", "Palatino Linotype", serif; color: var(--ink); background: linear-gradient(180deg, #f0eadc 0%, var(--bg) 100%); }
      header { padding: 20px 24px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,0.6); backdrop-filter: blur(10px); position: sticky; top: 0; }
      header h1 { margin: 0; font-size: 30px; }
      header p { margin: 6px 0 0; color: var(--muted); }
      main { display: grid; grid-template-columns: 360px 1fr; min-height: calc(100vh - 89px); }
      aside { border-right: 1px solid var(--line); padding: 18px; overflow: auto; }
      #units { display: grid; gap: 12px; }
      .unit-card { border: 1px solid var(--line); background: var(--panel); border-radius: 14px; padding: 14px; cursor: pointer; }
      .unit-card.active { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(31,111,74,0.15); }
      .unit-card h2 { margin: 0 0 8px; font-size: 17px; }
      .meta { color: var(--muted); font-size: 14px; line-height: 1.4; }
      .status { display: inline-block; margin-top: 8px; padding: 3px 8px; border-radius: 999px; font-size: 12px; background: #efe6d7; }
      section { padding: 24px; overflow: auto; }
      .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 20px; }
      .eyebrow { color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px; margin-bottom: 8px; }
      .descriptor { font-size: 28px; margin: 8px 0 6px; }
      .confidence { color: var(--accent-2); font-size: 14px; }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 18px; }
      .list-block { border: 1px solid var(--line); border-radius: 12px; padding: 14px; min-height: 120px; }
      .list-block h3 { font-size: 15px; margin: 0 0 10px; }
      ul { margin: 0; padding-left: 18px; }
      li { margin: 4px 0; }
      .actions { display: grid; gap: 12px; margin-top: 20px; }
      input, textarea, button { font: inherit; }
      textarea, input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: #fff; }
      .button-row { display: flex; gap: 10px; flex-wrap: wrap; }
      button { border: none; border-radius: 999px; padding: 10px 16px; cursor: pointer; background: #efe6d7; }
      button.primary { background: var(--accent); color: white; }
      button.reject { background: var(--danger); color: white; }
      #empty { color: var(--muted); }
      @media (max-width: 900px) { main { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid var(--line); } .grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <header>
      <h1>WDIT Review</h1>
      <p>Review flow variants, approve descriptors, and promote vocabulary.</p>
    </header>
    <main>
      <aside><div id="units"></div></aside>
      <section><div id="detail" class="panel"><p id="empty">Select a flow variant to review.</p></div></section>
    </main>
    <script>
      let state = { units: [], vocabulary: [], selectedId: null };
      const summarize = (value) => Array.isArray(value) && value.length > 0 ? value.join(", ") : "-";
      const escapeHtml = (value) => String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");

      async function loadState() {
        const [unitsRes, vocabRes] = await Promise.all([fetch("/review/units"), fetch("/review/vocabulary")]);
        state.units = await unitsRes.json();
        state.vocabulary = await vocabRes.json();
        if (!state.selectedId && state.units[0]) state.selectedId = state.units[0].reviewId;
        render();
      }

      function renderList() {
        const container = document.getElementById("units");
        container.innerHTML = state.units.map((unit) => \`
          <article class="unit-card \${unit.reviewId === state.selectedId ? "active" : ""}" data-id="\${escapeHtml(unit.reviewId)}">
            <h2>\${escapeHtml(unit.approvedDescriptor || unit.proposedDescriptor || unit.canonical.join(" → "))}</h2>
            <div class="meta">Flow: \${escapeHtml(unit.canonical.join(" → "))}</div>
            <div class="meta">Count: \${unit.count}</div>
            <div class="meta">Tests: \${escapeHtml(summarize(unit.tests))}</div>
            <div class="status">\${escapeHtml(unit.reviewStatus)} / \${escapeHtml(unit.proposalState)}</div>
          </article>\`).join("");
        container.querySelectorAll(".unit-card").forEach((node) => {
          node.addEventListener("click", () => { state.selectedId = node.getAttribute("data-id"); render(); });
        });
      }

      function renderListBlock(title, values) {
        const items = Array.isArray(values) && values.length > 0
          ? values.map((value) => \`<li>\${escapeHtml(value)}</li>\`).join("")
          : "<li>-</li>";
        return \`<div class="list-block"><h3>\${escapeHtml(title)}</h3><ul>\${items}</ul></div>\`;
      }

      function renderDetail() {
        const detail = document.getElementById("detail");
        const unit = state.units.find((candidate) => candidate.reviewId === state.selectedId);
        if (!unit) {
          detail.innerHTML = '<p id="empty">Select a flow variant to review.</p>';
          return;
        }
        detail.innerHTML = \`
          <div class="eyebrow">Review Variant</div>
          <div class="descriptor">\${escapeHtml(unit.approvedDescriptor || unit.proposedDescriptor || "Pending proposal")}</div>
          <div class="confidence">Confidence: \${unit.proposedConfidence != null ? unit.proposedConfidence.toFixed(2) : "-"}</div>
          <p>\${escapeHtml(unit.proposedRationale || unit.proposalError || "No proposal yet.")}</p>
          <p><strong>Flow:</strong> \${escapeHtml(unit.canonical.join(" → "))}</p>
          <p><strong>Suites:</strong> \${escapeHtml(summarize(unit.suites))}</p>
          <p><strong>Tests:</strong> \${escapeHtml(summarize(unit.tests))}</p>
          <p><strong>Tools:</strong> \${escapeHtml(summarize(unit.tools))}</p>
          <p><strong>Browsers:</strong> \${escapeHtml(summarize(unit.browsers))}</p>
          <div class="grid">
            \${renderListBlock("Final URLs", unit.finalUrls)}
            \${renderListBlock("Headings", unit.headings)}
            \${renderListBlock("Alerts", unit.alerts)}
            \${renderListBlock("Targets", unit.targets)}
            \${renderListBlock("Candidate Vocab", unit.candidateVocab)}
            \${renderListBlock("Proposed Vocab", unit.proposedVocab)}
          </div>
          <div class="actions">
            <label><div class="eyebrow">Approved Descriptor</div><input id="approvedDescriptor" value="\${escapeHtml(unit.approvedDescriptor || unit.proposedDescriptor || "")}" /></label>
            <label><div class="eyebrow">Promote Vocabulary Terms</div><input id="promoteVocab" value="\${escapeHtml(unit.proposedVocab.join(", "))}" /></label>
            <label><div class="eyebrow">Notes</div><textarea id="reviewNotes" rows="4">\${escapeHtml(unit.notes || "")}</textarea></label>
            <div class="button-row">
              <button class="primary" data-action="approved">Approve</button>
              <button data-action="overridden">Override</button>
              <button class="reject" data-action="rejected">Reject</button>
            </div>
          </div>\`;

        detail.querySelectorAll("button[data-action]").forEach((button) => {
          button.addEventListener("click", async () => {
            const reviewStatus = button.getAttribute("data-action");
            const approvedDescriptor = document.getElementById("approvedDescriptor").value.trim();
            const promoteVocab = document.getElementById("promoteVocab").value.split(",").map((value) => value.trim()).filter(Boolean);
            const notes = document.getElementById("reviewNotes").value.trim();
            await fetch(\`/review/units/\${encodeURIComponent(unit.reviewId)}\`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ reviewStatus, approvedDescriptor, notes, promoteVocab }),
            });
            await loadState();
          });
        });
      }

      function render() { renderList(); renderDetail(); }
      loadState();
      setInterval(loadState, 4000);
    </script>
  </body>
</html>`;
}

function inferBrowserInfo(req: http.IncomingMessage): BrowserInfo | undefined {
  const userAgent = req.headers["user-agent"];

  if (typeof userAgent !== "string") {
    return undefined;
  }

  const chromiumLike = /Chrome\/([0-9.]+)/.exec(userAgent);

  if (chromiumLike) {
    return {
      family: "chromium",
      version: chromiumLike[1],
      source: "bootstrap-request",
    };
  }

  const firefox = /Firefox\/([0-9.]+)/.exec(userAgent);

  if (firefox) {
    return {
      family: "firefox",
      version: firefox[1],
      source: "bootstrap-request",
    };
  }

  const safari = /Version\/([0-9.]+).*Safari\//.exec(userAgent);

  if (safari) {
    return {
      family: "webkit",
      version: safari[1],
      source: "bootstrap-request",
    };
  }

  return undefined;
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
        `${serverUrl}/bootstrap` +
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
        environment: body.environment,
        endState: body.endState,
        events: body.events,
      });
      markRunIngested(runInfo.id, runInfo.endedAt, runInfo.reason);
      await refreshReviewUnits();

      writeJson(res, 202, { ok: true, flowId: processed.flowId });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      writeJson(res, 500, { error: message });
      return;
    }
  }

  if (req.method === "GET" && req.url?.startsWith("/bootstrap")) {
    const requestUrl = new URL(req.url, getServerUrl(req));
    const runId = requestUrl.searchParams.get("runId");

    if (runId) {
      const browser = inferBrowserInfo(req);

      if (browser) {
        updateRunEnvironment(runId, { browser });
      }
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderBootstrapPage());
    return;
  }

  if (req.method === "GET" && req.url === "/review") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderReviewPage());
    return;
  }

  if (req.method === "GET" && req.url === "/review/units") {
    writeJson(res, 200, await loadReviewUnits());
    return;
  }

  if (req.method === "GET" && req.url === "/review/vocabulary") {
    writeJson(res, 200, await readJsonFile(getVocabularyPath(), []));
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/review/units/")) {
    try {
      const reviewId = decodeURIComponent(req.url.slice("/review/units/".length));
      const body = (await readJsonBody(req)) as
        | {
            reviewStatus?: "approved" | "rejected" | "overridden";
            approvedDescriptor?: string;
            notes?: string;
            promoteVocab?: string[];
          }
        | null;

      if (
        !body ||
        (body.reviewStatus !== "approved" && body.reviewStatus !== "rejected" && body.reviewStatus !== "overridden")
      ) {
        writeJson(res, 400, { error: "Invalid review payload" });
        return;
      }

      const updated = await saveReviewDecision({
        reviewId,
        reviewStatus: body.reviewStatus,
        approvedDescriptor: body.approvedDescriptor,
        notes: body.notes,
        promoteVocab: Array.isArray(body.promoteVocab) ? body.promoteVocab : [],
      });

      if (!updated) {
        writeJson(res, 404, { error: "Review unit not found" });
        return;
      }

      writeJson(res, 200, updated);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      writeJson(res, 500, { error: message });
      return;
    }
  }

  if (req.method === "POST" && req.url === "/review/vocabulary") {
    try {
      const body = (await readJsonBody(req)) as
        | { term?: string; status?: "approved" | "rejected" | "proposed"; description?: string; aliases?: string[] }
        | null;

      if (!body || typeof body.term !== "string") {
        writeJson(res, 400, { error: "Invalid vocabulary payload" });
        return;
      }

      const updated = await upsertVocabulary({
        term: body.term,
        status: body.status,
        description: body.description,
        aliases: Array.isArray(body.aliases) ? body.aliases : undefined,
      });

      if (!updated) {
        writeJson(res, 400, { error: "Vocabulary term is required" });
        return;
      }

      writeJson(res, 200, updated);
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
await refreshReviewUnits();

server.listen(PORT, HOST, () => {
  console.log(`WDIT server listening on http://${HOST}:${PORT}`);
});
