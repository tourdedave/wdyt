import http from "node:http";

import { DEFAULT_SERVER_URL } from "../shared/constants.js";
import { ensureDataDir, getVocabularyPath, readJsonFile } from "../shared/fs.js";
import type { BrowserInfo, EndRunRequest, StartRunRequest } from "../shared/types.js";
import { validateIngestPayload } from "../shared/validation.js";
import { createCriticalFlow, deleteCriticalFlow, loadCriticalFlowState, parseCriticalFlow, updateCriticalFlow } from "./critical-flows.js";
import { loadReviewUnits, refreshReviewUnits, requestReviewUnitReprocess, saveReviewUnitEdits, upsertVocabulary } from "./review.js";
import { persistRun } from "./storage.js";
import { bindRun, buildRunInfoForIngest, getBoundRun, markRunIngested, requestRunEnd, startRun, updateRunEnvironment } from "./state.js";

const HOST = process.env.WDYT_HOST ?? "127.0.0.1";
const PORT = Number(process.env.WDYT_PORT ?? "3876");

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
    <title>What Did You Test? | Bootstrap</title>
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
    <h1 id="status">WDYT initializing</h1>
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
            finish("error", "WDYT bind timed out", "No response from content script bridge");
          }
        }, 5000);

        const bindIntervalId = setInterval(() => {
          if (resolved) {
            clearInterval(bindIntervalId);
            return;
          }

          window.postMessage(
            {
              kind: "WDYT_BIND_RUN",
              runId,
              serverUrl
            },
            "*"
          );
        }, 250);

        window.addEventListener("message", (event) => {
          if (event.source !== window || !event.data || event.data.kind !== "WDYT_BIND_RESULT") {
            return;
          }

          if (event.data.ok) {
            clearTimeout(timeoutId);
            clearInterval(bindIntervalId);
            finish("ok", "WDYT bound", \`runId=\${runId} browserSessionId=\${event.data.browserSessionId}\`);
            return;
          }

          clearTimeout(timeoutId);
          clearInterval(bindIntervalId);
          finish("error", "WDYT bind failed", event.data.error || "Unknown error");
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
    <title>What Did You Test? | Review</title>
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
      header h1 a { color: inherit; text-decoration: none; }
      header h1 a:hover { text-decoration: underline; }
      header p { margin: 6px 0 0; color: var(--muted); }
      nav { margin-top: 10px; display: flex; gap: 12px; flex-wrap: wrap; }
      nav a { color: var(--accent); text-decoration: none; font-weight: 600; }
      nav a.active { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
      main { display: grid; grid-template-columns: 360px 1fr; min-height: calc(100vh - 89px); }
      aside { border-right: 1px solid var(--line); padding: 18px; overflow: auto; }
      #units { display: grid; gap: 12px; }
      .unit-card { border: 1px solid var(--line); background: var(--panel); border-radius: 14px; padding: 14px; cursor: pointer; }
      .unit-card.active { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(31,111,74,0.15); }
      .unit-card h2 { margin: 0 0 8px; font-size: 17px; }
      .meta { color: var(--muted); font-size: 14px; line-height: 1.4; }
      .overlap-summary { display: grid; gap: 10px; margin-bottom: 22px; }
      .overlap-card { border: 1px solid var(--line); background: var(--panel); border-radius: 12px; padding: 12px; cursor: pointer; }
      .overlap-card.active { border-color: var(--accent-2); box-shadow: 0 0 0 2px rgba(138,90,24,0.14); }
      .overlap-term { display: inline-block; font-weight: 700; font-size: 16px; margin-bottom: 6px; }
      .status { display: inline-block; margin-top: 8px; padding: 3px 8px; border-radius: 999px; font-size: 12px; background: #efe6d7; }
      .unit-card.related { border-color: var(--accent-2); box-shadow: 0 0 0 2px rgba(138,90,24,0.12); }
      .unit-card.dimmed { opacity: 0.56; }
      section { padding: 24px; overflow: auto; }
      .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 20px; }
      .descriptor { font-size: 28px; margin: 8px 0 6px; }
      .confidence { color: var(--accent-2); font-size: 14px; }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 18px; }
      .list-block { border: 1px solid var(--line); border-radius: 12px; padding: 14px; min-height: 120px; min-width: 0; }
      .list-block h3 { font-size: 15px; margin: 0 0 10px; }
      ul { margin: 0; padding-left: 18px; }
      li { margin: 4px 0; overflow-wrap: anywhere; word-break: break-word; }
      .actions { display: grid; gap: 12px; margin-top: 20px; }
      input, textarea, button { font: inherit; }
      textarea, input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: #fff; }
      .button-row { display: flex; gap: 10px; flex-wrap: wrap; }
      button { border: none; border-radius: 999px; padding: 10px 16px; cursor: pointer; background: #efe6d7; }
      button.primary { background: var(--accent); color: white; }
      button.reject { background: var(--danger); color: white; }
      #empty { color: var(--muted); }
      .summary-link { color: var(--accent); text-decoration: none; font-weight: 600; }
      .decision-editor { display: none; }
      .decision-editor.open { display: grid; }
      .transition-banner { margin-bottom: 14px; padding: 10px 12px; border-radius: 10px; background: rgba(31,111,74,0.12); color: var(--accent); font-size: 14px; }
      .panel.is-submitting { opacity: 0.72; transition: opacity 120ms ease; }
      @media (max-width: 900px) { main { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid var(--line); } .grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <header>
      <h1><a href="/review/summary">What Did You Test?</a></h1>
      <p>Review flow variants, refine interpretations, and reprocess them when needed.</p>
      <nav>
        <a class="active" href="/review">Review</a>
        <a href="/review/summary">Summary</a>
        <a href="/critical-flows">Critical Flows</a>
      </nav>
    </header>
    <main>
      <aside><div id="overlapSummary"></div><div id="units"></div></aside>
      <section><div id="detail" class="panel"><p id="empty">Select a flow variant to review.</p></div></section>
    </main>
    <script>
      let state = { units: [], vocabulary: [], selectedId: null, editingId: null, submittingReviewId: null, transitionMessage: "", pendingFocusHeading: false, activeOverlapKey: null };
      const summarize = (value) => Array.isArray(value) && value.length > 0 ? value.join(", ") : "-";
      const escapeHtml = (value) => String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
      const getActiveUnits = () => state.units.filter((unit) => unit.proposalState === "proposed" || unit.activeDescriptor);
      const getOverlapVocab = (unit) => Array.isArray(unit.overlapTerms) ? unit.overlapTerms : [];
      const getSharedOverlapCount = (leftValues, rightValues) => {
        const right = new Set((rightValues || []).map((value) => String(value).trim()).filter(Boolean));
        return (leftValues || []).filter((value) => right.has(String(value).trim())).length;
      };
      const isOverlapMatch = (leftValues, rightValues) => {
        const left = (leftValues || []).map((value) => String(value).trim()).filter(Boolean);
        const right = (rightValues || []).map((value) => String(value).trim()).filter(Boolean);
        const shared = getSharedOverlapCount(left, right);
        const maxCount = Math.max(left.length, right.length);
        if (maxCount === 0) {
          return false;
        }

        if (shared >= 2 && shared / maxCount >= 0.67) {
          return true;
        }

        return maxCount <= 2 && shared === maxCount && maxCount > 0;
      };
      const getComparableUnits = () =>
        state.units.filter(
          (unit) =>
            unit.proposalState === "proposed" && (unit.activeDescriptor || unit.proposedDescriptor)
        );
      const getOverlapGroups = () => {
        const groups = [];
        getComparableUnits()
          .slice()
          .sort((a, b) => getOverlapVocab(a).length - getOverlapVocab(b).length || a.reviewId.localeCompare(b.reviewId))
          .forEach((unit) => {
          const vocab = getOverlapVocab(unit);
          if (vocab.length === 0) {
            return;
          }

          const matchedGroup = groups.find((group) =>
            group.units.some((candidate) => isOverlapMatch(vocab, getOverlapVocab(candidate)))
          );

          if (matchedGroup) {
            matchedGroup.units.push(unit);
            matchedGroup.vocab = [...new Set([...matchedGroup.vocab, ...vocab])].sort();
            return;
          }

          groups.push({
            key: "group-" + (groups.length + 1),
            vocab: [...vocab],
            units: [unit],
          });
        });

        return groups
          .filter((group) => group.units.length > 1)
          .sort((a, b) => b.units.length - a.units.length || a.vocab.join(" ").localeCompare(b.vocab.join(" ")));
      };
      const getOverlapTitle = (group) => {
        const descriptors = group.units
          .map((unit) => String(unit.activeDescriptor || unit.proposedDescriptor || unit.canonical.join(" → ")).trim())
          .filter(Boolean);
        if (descriptors.length === 0) {
          return group.vocab.join(" + ");
        }

        const counts = new Map();
        descriptors.forEach((descriptor) => {
          counts.set(descriptor, (counts.get(descriptor) || 0) + 1);
        });

        return [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0][0];
      };
      const getDisplayStatus = (unit) => {
        if (unit.interpretationStatus === "edited") return "edited";
        if (unit.interpretationStatus === "reprocessed") return "reprocessed";
        if (unit.proposalState === "proposed") return "ready for review";
        if (unit.proposalState === "processing") return "generating proposal";
        if (unit.proposalState === "error") return "proposal failed";
        return "auto-generated";
      };

      async function loadState() {
        const initialReviewId = new URLSearchParams(window.location.search).get("reviewId");
        const [unitsRes, vocabRes] = await Promise.all([fetch("/review/units"), fetch("/review/vocabulary")]);
        const nextUnits = await unitsRes.json();
        state.vocabulary = await vocabRes.json();
        if (state.editingId && nextUnits.some((unit) => unit.reviewId === state.editingId)) {
          state.units = nextUnits;
          renderList();
          return;
        }
        state.units = nextUnits;
        const activeUnits = getActiveUnits();
        if (!state.selectedId && initialReviewId && state.units.some((unit) => unit.reviewId === initialReviewId)) {
          state.selectedId = initialReviewId;
        }
        if (!state.selectedId && activeUnits[0]) state.selectedId = activeUnits[0].reviewId;
        if (state.selectedId && !state.units.some((unit) => unit.reviewId === state.selectedId)) {
          state.selectedId = activeUnits[0]?.reviewId ?? state.units[0]?.reviewId ?? null;
        }
        render();
      }

      function renderOverlapSummary() {
        const container = document.getElementById("overlapSummary");
        const groups = getOverlapGroups();

        if (groups.length === 0) {
          container.innerHTML = "";
          return;
        }

        container.innerHTML = \`
          <div class="overlap-summary">
            <p class="rail-title">Repeated Coverage</p>
            \${groups.map((group) => \`
              <article class="overlap-card \${group.key === state.activeOverlapKey ? "active" : ""}" data-key="\${escapeHtml(group.key)}">
                <div class="overlap-term">\${escapeHtml(getOverlapTitle(group))}</div>
                <div class="meta">Appears in \${escapeHtml(String(group.units.length))} flows:</div>
                <div class="meta">
                  \${group.units.map((unit) => \`<div>- \${escapeHtml(unit.activeDescriptor || unit.proposedDescriptor || unit.canonical.join(" → "))}</div>\`).join("")}
                </div>
              </article>\`).join("")}
          </div>\`;

        container.querySelectorAll(".overlap-card").forEach((node) => {
          node.addEventListener("click", () => {
            const key = node.getAttribute("data-key");
            state.activeOverlapKey = state.activeOverlapKey === key ? null : key;
            if (state.activeOverlapKey) {
              const group = getOverlapGroups().find((entry) => entry.key === state.activeOverlapKey);
              if (group?.units[0]) {
                state.selectedId = group.units[0].reviewId;
              }
            }
            render();
          });
        });
      }

      function renderList() {
        const container = document.getElementById("units");
        container.innerHTML = state.units.map((unit) => \`
          <article class="unit-card \${unit.reviewId === state.selectedId ? "active" : ""} \${state.activeOverlapKey && getOverlapGroups().find((group) => group.key === state.activeOverlapKey)?.units.some((candidate) => candidate.reviewId === unit.reviewId) ? "related" : ""} \${state.activeOverlapKey && !getOverlapGroups().find((group) => group.key === state.activeOverlapKey)?.units.some((candidate) => candidate.reviewId === unit.reviewId) ? "dimmed" : ""}" data-id="\${escapeHtml(unit.reviewId)}">
            <h2>\${escapeHtml(unit.activeDescriptor || unit.proposedDescriptor || unit.canonical.join(" → "))}</h2>
            <div class="status">\${escapeHtml(getDisplayStatus(unit))}</div>
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
          const activeUnits = getActiveUnits();
          if (activeUnits.length === 0) {
          detail.innerHTML = '<p id="empty">Waiting for interpreted flow variants.</p><p><a class="summary-link" href="/review/summary">Open summary readout</a></p>';
          } else {
            state.selectedId = activeUnits[0].reviewId;
            render();
          }
          return;
        }

        const isSubmitting = state.submittingReviewId === unit.reviewId;
        const llmVocab = [...new Set([...(unit.approvedVocabUsed || []), ...(unit.proposedVocab || [])])];
        detail.innerHTML = \`
          \${state.transitionMessage ? \`<div class="transition-banner" role="status">\${escapeHtml(state.transitionMessage)}</div>\` : ""}
          <div class="descriptor" id="reviewHeading" tabindex="-1">\${escapeHtml(unit.activeDescriptor || unit.proposedDescriptor || "Pending interpretation")}</div>
          <div class="confidence">Confidence: \${unit.proposedConfidence != null ? unit.proposedConfidence.toFixed(2) : "-"}</div>
          <p><strong>Status:</strong> \${escapeHtml(getDisplayStatus(unit))}</p>
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
            \${renderListBlock("Active Vocab", unit.activeVocab)}
            \${unit.interpretationStatus === "edited" ? renderListBlock("LLM Vocab", llmVocab) : ""}
          </div>
          <div class="actions"><div class="button-row"><button id="editDecision">Edit Flow</button><button id="reprocessFlow" \${isSubmitting ? "disabled" : ""}>Re-run Interpretation</button></div></div>
          <div class="actions decision-editor \${state.editingId === unit.reviewId ? "open" : ""}" id="decisionEditor">
            <label><div>Descriptor</div><input id="approvedDescriptor" value="\${escapeHtml(unit.activeDescriptor || unit.proposedDescriptor || "")}" /></label>
            <label><div>Vocabulary</div><input id="promoteVocab" value="\${escapeHtml((unit.activeVocab || []).join(", "))}" /></label>
            <label><div>Notes</div><textarea id="reviewNotes" rows="4">\${escapeHtml(unit.notes || "")}</textarea></label>
            <div class="button-row">
              <button class="primary" data-action="save" \${isSubmitting ? "disabled" : ""}>\${isSubmitting ? "Saving…" : "Save Changes"}</button>
              <button type="button" id="cancelDecision" \${isSubmitting ? "disabled" : ""}>Cancel</button>
            </div>
          </div>\`;
        detail.classList.toggle("is-submitting", isSubmitting);

        detail.querySelector("#editDecision")?.addEventListener("click", () => {
          state.editingId = unit.reviewId;
          detail.querySelector("#decisionEditor")?.classList.add("open");
        });

        detail.querySelector("#reprocessFlow")?.addEventListener("click", async () => {
          state.submittingReviewId = unit.reviewId;
          state.transitionMessage = "Re-running interpretation…";
          render();
          await fetch(\`/review/units/\${encodeURIComponent(unit.reviewId)}/reprocess\`, { method: "POST" });
          state.submittingReviewId = null;
          state.pendingFocusHeading = true;
          await loadState();
          setTimeout(() => {
            state.transitionMessage = "";
            render();
          }, 1200);
        });

        detail.querySelector("#cancelDecision")?.addEventListener("click", () => {
          state.editingId = null;
          render();
        });

        if (state.pendingFocusHeading) {
          detail.scrollTo({ top: 0, behavior: "auto" });
          detail.querySelector("#reviewHeading")?.focus();
          state.pendingFocusHeading = false;
        }

        detail.querySelectorAll("button[data-action]").forEach((button) => {
          button.addEventListener("click", async () => {
            const approvedDescriptor = document.getElementById("approvedDescriptor").value.trim();
            const promoteVocab = document.getElementById("promoteVocab").value.split(",").map((value) => value.trim()).filter(Boolean);
            const notes = document.getElementById("reviewNotes").value.trim();
            state.submittingReviewId = unit.reviewId;
            state.transitionMessage = "Saved flow changes.";
            render();
            await fetch(\`/review/units/\${encodeURIComponent(unit.reviewId)}\`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ descriptor: approvedDescriptor, vocab: promoteVocab, notes }),
            });
            state.editingId = null;
            state.submittingReviewId = null;
            state.pendingFocusHeading = true;
            await loadState();
            setTimeout(() => {
              state.transitionMessage = "";
              render();
            }, 1200);
          });
        });
      }

      function render() { renderOverlapSummary(); renderList(); renderDetail(); }
      loadState();
      setInterval(loadState, 4000);
    </script>
  </body>
</html>`;
}

function renderReviewSummaryPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>What Did You Test?</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f1e7;
        --panel: #fffdf8;
        --line: #d8cfbf;
        --ink: #1d1a16;
        --muted: #6d6458;
        --accent: #1f6f4a;
      }
      body { margin: 0; font-family: "Iowan Old Style", "Palatino Linotype", serif; background: linear-gradient(180deg, #f0eadc 0%, var(--bg) 100%); color: var(--ink); }
      header { padding: 20px 24px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,0.6); backdrop-filter: blur(10px); position: sticky; top: 0; }
      header h1 { margin: 0; font-size: 30px; }
      header h1 a { color: inherit; text-decoration: none; }
      header h1 a:hover { text-decoration: underline; }
      header p { margin: 6px 0 0; color: var(--muted); }
      nav { margin-top: 10px; display: flex; gap: 12px; flex-wrap: wrap; }
      nav a { color: var(--accent); text-decoration: none; font-weight: 600; }
      nav a.active { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
      main { max-width: 980px; margin: 0 auto; padding: 32px 20px 48px; }
      .card { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 18px; margin: 14px 0; cursor: pointer; }
      .descriptor { font-size: 24px; margin: 0 0 8px; }
      .meta { color: var(--muted); margin: 4px 0; }
      .back { color: var(--accent); text-decoration: none; font-weight: 600; }
      .details { display: none; margin-top: 10px; }
      .card.expanded .details { display: block; }
      .review-link { color: var(--accent); text-decoration: none; font-weight: 600; }
    </style>
  </head>
  <body>
    <header>
      <h1><a href="/review/summary">What Did You Test?</a></h1>
      <p>Summary</p>
      <nav>
        <a href="/review">Review</a>
        <a class="active" href="/review/summary">Summary</a>
        <a href="/critical-flows">Critical Flows</a>
      </nav>
    </header>
    <main>
      <div id="summary">Loading…</div>
      <p><a class="back" href="/review">Back to review</a></p>
    </main>
    <script>
      const escapeHtml = (value) => String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");

      async function loadSummary() {
        const units = await fetch("/review/units").then((response) => response.json());
        const approved = units.filter((unit) => unit.proposalState === "proposed" && (unit.activeDescriptor || unit.proposedDescriptor));
        const target = document.getElementById("summary");

        if (approved.length === 0) {
          target.innerHTML = "<p>No interpreted descriptors yet.</p>";
          return;
        }

        target.innerHTML = approved.map((unit) => \`
          <article class="card" data-review-id="\${escapeHtml(unit.reviewId)}">
            <h2 class="descriptor">\${escapeHtml(unit.activeDescriptor || unit.proposedDescriptor || unit.canonical.join(" → "))}</h2>
            <div class="details">
              <p class="meta">Suites: \${escapeHtml((unit.suites || []).join(", ") || "-")}</p>
              <p class="meta">Tests: \${escapeHtml((unit.tests || []).join(", ") || "-")}</p>
              <p class="meta">Flow: \${escapeHtml((unit.canonical || []).join(" → "))}</p>
              <p class="meta">Final URLs: \${escapeHtml((unit.finalUrls || []).join(", ") || "-")}</p>
              <p class="meta">Confidence: \${unit.proposedConfidence != null ? unit.proposedConfidence.toFixed(2) : "-"}</p>
              <p class="meta">Rationale: \${escapeHtml(unit.proposedRationale || "-")}</p>
              <p><a class="review-link" href="/review?reviewId=\${encodeURIComponent(unit.reviewId)}">Open full review detail</a></p>
            </div>
          </article>\`).join("");

        target.querySelectorAll(".card").forEach((card) => {
          card.addEventListener("click", (event) => {
            if (event.target.closest("a")) {
              return;
            }

            card.classList.toggle("expanded");
          });
        });
      }

      loadSummary();
    </script>
  </body>
</html>`;
}

function renderCriticalFlowsPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>What Did You Test? | Critical Flows</title>
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
        --warn: #b76e1b;
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Iowan Old Style", "Palatino Linotype", serif; color: var(--ink); background: linear-gradient(180deg, #f0eadc 0%, var(--bg) 100%); }
      header { padding: 20px 24px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,0.6); backdrop-filter: blur(10px); position: sticky; top: 0; z-index: 10; }
      header h1 { margin: 0; font-size: 30px; }
      header h1 a { color: inherit; text-decoration: none; }
      header p { margin: 6px 0 0; color: var(--muted); }
      nav { margin-top: 10px; display: flex; gap: 12px; flex-wrap: wrap; }
      nav a { color: var(--accent); text-decoration: none; font-weight: 600; }
      nav a.active { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
      main { display: grid; grid-template-columns: 320px 1fr; min-height: calc(100vh - 119px); }
      aside { border-right: 1px solid var(--line); padding: 18px; overflow: auto; }
      section { padding: 24px; overflow: auto; }
      .rail-title { font-size: 14px; color: var(--muted); margin: 0 0 12px; letter-spacing: 0.04em; text-transform: uppercase; }
      .gap-summary { display: grid; gap: 10px; margin-bottom: 22px; }
      .gap-card { border: 1px solid var(--line); background: var(--panel); border-radius: 12px; padding: 12px; cursor: pointer; }
      .gap-card.active { border-color: var(--warn); box-shadow: 0 0 0 2px rgba(183,110,27,0.14); }
      .gap-term { display: inline-block; font-weight: 700; font-size: 16px; margin-bottom: 6px; }
      .gap-meta { color: var(--muted); font-size: 13px; line-height: 1.45; }
      #flows { display: grid; gap: 12px; }
      .flow-card { border: 1px solid var(--line); background: var(--panel); border-radius: 14px; padding: 14px; cursor: pointer; }
      .flow-card.active { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(31,111,74,0.15); }
      .flow-card.related { border-color: var(--warn); box-shadow: 0 0 0 2px rgba(183,110,27,0.12); }
      .flow-card.dimmed { opacity: 0.56; }
      .flow-card h2 { margin: 0 0 10px; font-size: 17px; }
      .status-chip { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 12px; }
      .status-chip.covered { background: rgba(31,111,74,0.12); color: var(--accent); }
      .status-chip.partial { background: rgba(183,110,27,0.15); color: var(--warn); }
      .status-chip.missing { background: rgba(159,29,29,0.12); color: var(--danger); }
      .missing-preview { margin-top: 8px; font-size: 14px; color: var(--ink); }
      .missing-preview strong { color: var(--danger); }
      .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 20px; }
      .stack { display: grid; gap: 18px; }
      .intro h2, .detail-header h2 { margin: 0 0 8px; font-size: 28px; }
      .intro p, .detail-header p, .meta { color: var(--muted); margin: 0; line-height: 1.5; }
      .example-list { margin: 12px 0 0; padding-left: 18px; }
      .form-grid { display: grid; gap: 12px; }
      textarea, input, button { font: inherit; }
      textarea, input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: #fff; }
      textarea { min-height: 96px; resize: vertical; }
      .button-row { display: flex; gap: 10px; flex-wrap: wrap; }
      button { border: none; border-radius: 999px; padding: 10px 16px; cursor: pointer; background: #efe6d7; }
      button.primary { background: var(--accent); color: white; }
      button.ghost-link { background: transparent; padding: 0; color: var(--accent); text-decoration: underline; }
      button:disabled { opacity: 0.6; cursor: wait; }
      .interpretation, .callout, .detail-block, .suggestions { border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
      .duplicate-warning { border: 1px solid rgba(183,110,27,0.35); background: rgba(183,110,27,0.08); border-radius: 12px; padding: 14px; }
      .duplicate-warning h3 { margin: 0 0 8px; font-size: 18px; }
      .duplicate-match { border-top: 1px solid rgba(216,207,191,0.8); padding-top: 12px; margin-top: 12px; }
      .duplicate-match:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
      .duplicate-label { color: var(--muted); font-size: 13px; margin-bottom: 6px; }
      .callout { background: #f9f4ea; }
      .error { color: var(--danger); }
      .add-flow-bar { display: flex; justify-content: flex-start; margin-bottom: 18px; }
      .add-flow-button { border: 1px solid var(--line); background: transparent; color: var(--accent); font-weight: 600; }
      .modal-backdrop { position: fixed; inset: 0; background: rgba(29,26,22,0.28); display: flex; align-items: flex-start; justify-content: center; padding: 48px 20px; z-index: 20; overflow-y: auto; }
      .modal-card { position: relative; width: min(760px, 100%); max-height: calc(100vh - 96px); overflow-y: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 20px; box-shadow: 0 24px 60px rgba(29,26,22,0.18); }
      .modal-shell { position: relative; padding-top: 18px; }
      .modal-close { position: absolute; top: 0; right: 0; border: 1px solid rgba(216,207,191,0.9); background: rgba(255,253,248,0.94); color: var(--muted); width: 30px; height: 30px; padding: 0; border-radius: 999px; font-size: 18px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; box-shadow: 0 4px 16px rgba(29,26,22,0.08); }
      .modal-close:hover { color: var(--ink); border-color: var(--line); }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
      .list-block { border: 1px solid var(--line); border-radius: 12px; padding: 14px; min-width: 0; }
      .list-block h3 { margin: 0 0 10px; font-size: 15px; }
      ul { margin: 0; padding-left: 18px; }
      li { margin: 4px 0; overflow-wrap: anywhere; word-break: break-word; }
      .pills { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
      .pill { border: 1px solid var(--line); border-radius: 999px; background: #fff; padding: 8px 12px; cursor: pointer; }
      .empty-note { color: var(--muted); }
      @media (max-width: 900px) { main { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid var(--line); } .grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <header>
      <h1><a href="/review/summary">What Did You Test?</a></h1>
      <p>Define the flows that matter most, then compare them against interpreted reviewed tests.</p>
      <nav>
        <a href="/review">Review</a>
        <a href="/review/summary">Summary</a>
        <a class="active" href="/critical-flows">Critical Flows</a>
      </nav>
    </header>
    <main>
      <aside>
        <div id="gapSummary"></div>
        <p class="rail-title">Saved Critical Flows</p>
        <div id="flows"></div>
      </aside>
      <section><div id="detail" class="panel">Loading…</div></section>
    </main>
    <script>
      let state = { flows: [], suggestions: [], hasDescriptors: false, selectedId: null, draftText: "", parsedDraft: null, isWorking: false, error: "", activeGapTerm: null, showDraftForm: false, editingFlowId: null };
      const escapeHtml = (value) => String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
      const statusLabel = (status) => status[0].toUpperCase() + status.slice(1);
      const summarizeItems = (values) => Array.isArray(values) && values.length > 0
        ? values.map((value) => \`<li>\${escapeHtml(value.name || value)}</li>\`).join("")
        : "<li>-</li>";
      const normalizeCompareValue = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
      const computeOverlapScore = (leftValues, rightValues) => {
        const left = [...new Set((leftValues || []).map(normalizeCompareValue).filter(Boolean))];
        const right = new Set((rightValues || []).map(normalizeCompareValue).filter(Boolean));
        if (left.length === 0 || right.size === 0) {
          return 0;
        }

        const shared = left.filter((value) => right.has(value));
        return shared.length / Math.max(left.length, right.size);
      };
      const getLikelyDuplicates = (draft) => {
        if (!draft) {
          return [];
        }

        return state.flows
          .filter((flow) => flow.id !== state.editingFlowId)
          .map((flow) => {
            const termOverlap = computeOverlapScore(draft.interpretedTerms, flow.interpretedTerms);
            const stepOverlap = computeOverlapScore(draft.interpretedSteps, flow.interpretedSteps);
            const normalizedDraftOutcome = normalizeCompareValue(draft.outcome || "");
            const normalizedFlowOutcome = normalizeCompareValue(flow.outcome || "");
            const sameOutcome = normalizedDraftOutcome === normalizedFlowOutcome;
            const exactDuplicate = termOverlap === 1 && stepOverlap >= 0.8 && sameOutcome;
            const likelyDuplicate = exactDuplicate || termOverlap >= 0.8 || stepOverlap >= 0.8;
            const matchedConcepts = [...new Set((draft.interpretedTerms || []).filter((term) =>
              (flow.interpretedTerms || []).map(normalizeCompareValue).includes(normalizeCompareValue(term))
            ))];

            return {
              flow,
              exactDuplicate,
              likelyDuplicate,
              matchedConcepts,
              score: termOverlap * 0.7 + stepOverlap * 0.3 + (sameOutcome ? 0.1 : 0),
            };
          })
          .filter((match) => match.likelyDuplicate)
          .sort((a, b) => b.score - a.score || a.flow.name.localeCompare(b.flow.name))
          .slice(0, 3);
      };
      async function interpretDraft(rawText) {
        state.draftText = rawText;
        state.parsedDraft = null;
        state.error = "";
        state.isWorking = true;
        render();

        try {
          const response = await fetch("/critical-flows/interpret", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ rawText: state.draftText }),
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || "Unable to interpret critical flow.");
          }
          state.parsedDraft = payload;
        } catch (error) {
          state.error = error instanceof Error ? error.message : "Unable to interpret critical flow.";
        } finally {
          state.isWorking = false;
          render();
        }
      }
      const getGapSummary = () => {
        const summary = new Map();
        state.flows.forEach((flow) => {
          (flow.missingTerms || []).forEach((term) => {
            const current = summary.get(term) || [];
            current.push(flow);
            summary.set(term, current);
          });
        });

        return [...summary.entries()]
          .map(([term, flows]) => ({ term, flows: flows.sort((a, b) => a.name.localeCompare(b.name)) }))
          .sort((a, b) => b.flows.length - a.flows.length || a.term.localeCompare(b.term));
      };
      const getMissingPreview = (flow) => {
        if (!Array.isArray(flow.missingTerms) || flow.missingTerms.length === 0) {
          return "";
        }

        const [first, ...rest] = flow.missingTerms;
        return rest.length > 0 ? \`\${first} +\${rest.length} more\` : first;
      };

      async function loadState() {
        const response = await fetch("/critical-flows/state");
        const nextState = await response.json();
        state.flows = nextState.flows;
        state.suggestions = nextState.suggestions;
        state.hasDescriptors = nextState.hasDescriptors;
        if (state.activeGapTerm && !getGapSummary().some((entry) => entry.term === state.activeGapTerm)) {
          state.activeGapTerm = null;
        }
        if (!state.selectedId && state.flows[0]) {
          state.selectedId = state.flows[0].id;
        }
        if (state.selectedId && !state.flows.some((flow) => flow.id === state.selectedId)) {
          state.selectedId = state.flows[0]?.id ?? null;
        }
        render();
      }

      function renderGapSummary() {
        const container = document.getElementById("gapSummary");
        const gaps = getGapSummary();

        if (gaps.length === 0) {
          container.innerHTML = "";
          return;
        }

        container.innerHTML = \`
          <div class="gap-summary">
            <p class="rail-title">Coverage Gaps</p>
            \${gaps.map((gap) => \`
              <article class="gap-card \${gap.term === state.activeGapTerm ? "active" : ""}" data-term="\${escapeHtml(gap.term)}">
                <div class="gap-term">\${escapeHtml(gap.term)}</div>
                <div class="gap-meta">\${gap.flows.length === 1 ? "Missing in:" : \`Missing in \${escapeHtml(String(gap.flows.length))} flows:\`}</div>
                <div class="gap-meta">
                  \${gap.flows.slice(0, 2).map((flow) => \`<div>\${gap.flows.length === 1 ? escapeHtml(flow.name) : \`- \${escapeHtml(flow.name)}\`}</div>\`).join("")}
                  \${gap.flows.length > 2 ? \`<div>+\${escapeHtml(String(gap.flows.length - 2))} more</div>\` : ""}
                </div>
              </article>\`).join("")}
          </div>\`;

        container.querySelectorAll(".gap-card").forEach((node) => {
          node.addEventListener("click", () => {
            const term = node.getAttribute("data-term");
            state.activeGapTerm = state.activeGapTerm === term ? null : term;
            if (state.activeGapTerm) {
              const firstMatch = state.flows.find((flow) => (flow.missingTerms || []).includes(state.activeGapTerm));
              if (firstMatch) {
                state.selectedId = firstMatch.id;
              }
            }
            render();
          });
        });
      }

      function renderList() {
        const container = document.getElementById("flows");
        if (state.flows.length === 0) {
          container.innerHTML = '<p class="empty-note">No critical flows saved yet.</p>';
          return;
        }

        container.innerHTML = state.flows.map((flow) => {
          const isAffectedByGap = state.activeGapTerm ? (flow.missingTerms || []).includes(state.activeGapTerm) : false;
          const showDimmed = state.activeGapTerm && !isAffectedByGap;
          const missingPreview = getMissingPreview(flow);
          return \`
          <article class="flow-card \${flow.id === state.selectedId ? "active" : ""} \${isAffectedByGap ? "related" : ""} \${showDimmed ? "dimmed" : ""}" data-id="\${escapeHtml(flow.id)}">
            <h2>\${escapeHtml(flow.name)}</h2>
            <span class="status-chip \${escapeHtml(flow.status)}">\${escapeHtml(statusLabel(flow.status))}</span>
            \${missingPreview ? \`<div class="missing-preview"><strong>Missing:</strong> \${escapeHtml(missingPreview)}</div>\` : ""}
          </article>\`;
        }).join("");
        container.querySelectorAll(".flow-card").forEach((node) => {
          node.addEventListener("click", () => {
            state.selectedId = node.getAttribute("data-id");
            render();
          });
        });
      }

      function renderListBlock(title, values) {
        return \`<div class="list-block"><h3>\${escapeHtml(title)}</h3><ul>\${summarizeItems(values)}</ul></div>\`;
      }

      function renderDraftArea(options = {}) {
        const compact = options.compact === true;
        const parsed = state.parsedDraft;
        const duplicateMatches = getLikelyDuplicates(parsed);
        const examples = state.suggestions.length === 0 ? \`
          <ul class="example-list">
            <li>Log in successfully</li>
            <li>Reset password</li>
            <li>Create and export a report</li>
            <li>Invite a new user</li>
          </ul>\` : "";
        const suggestions = state.hasDescriptors && state.suggestions.length > 0
          ? \`<div class="suggestions">
              <strong>Suggested from reviewed tests</strong>
              <div class="pills">
                \${state.suggestions.map((suggestion) => \`<button type="button" class="pill" data-suggestion="\${escapeHtml(suggestion)}">+ \${escapeHtml(suggestion)}</button>\`).join("")}
              </div>
            </div>\`
          : "";

        return \`
          <div class="stack">
            <div class="intro">
              <h2>What are the most important things your application must do?</h2>
              <p>Capture each critical business flow one at a time, then compare it against interpreted reviewed tests.</p>
              \${examples}
            </div>
            \${suggestions}
            <div class="form-grid">
              <label>
                <div>Critical flow</div>
                <textarea id="criticalFlowInput" placeholder="Log in and export a report to CSV">\${escapeHtml(state.draftText)}</textarea>
              </label>
              <div class="button-row">
                <button class="primary" id="interpretFlow" \${state.isWorking ? "disabled" : ""}>Interpret</button>
                \${compact ? '<button type="button" id="cancelCriticalFlow">Cancel</button>' : ""}
              </div>
              \${state.error ? \`<p class="error">\${escapeHtml(state.error)}</p>\` : ""}
            </div>
            \${parsed ? \`
              <div class="interpretation">
                <strong>Interpreted as</strong>
                <ul>\${parsed.interpretedSteps.map((step) => \`<li>\${escapeHtml(step)}</li>\`).join("")}</ul>
                <p><strong>Interpreted terms:</strong> \${escapeHtml(parsed.interpretedTerms.join(", "))}</p>
                <p><strong>Outcome:</strong> \${escapeHtml(parsed.outcome || "-")}</p>
                \${duplicateMatches.length > 0 ? \`
                  <div class="duplicate-warning">
                    <h3>Possible duplicate detected</h3>
                    <p class="meta">\${duplicateMatches.some((match) => match.exactDuplicate)
                      ? "This flow appears to already exist:"
                      : "This flow appears similar to an existing critical flow:"}</p>
                    \${duplicateMatches.map((match) => \`
                      <div class="duplicate-match">
                        <div class="duplicate-label">\${match.exactDuplicate ? "Existing flow" : "Similar flow"}</div>
                        <strong>\${escapeHtml(match.flow.name)}</strong>
                        \${match.matchedConcepts.length > 0 ? \`<p class="meta">Matched concepts: \${escapeHtml(match.matchedConcepts.join(", "))}</p>\` : ""}
                        <div class="button-row">
                          <button type="button" data-view-duplicate="\${escapeHtml(match.flow.id)}">View Existing Flow</button>
                        </div>
                      </div>\`).join("")}
                  </div>\`
                : ""}
                <div class="button-row">
                  <button class="primary" id="saveCriticalFlow" \${state.isWorking ? "disabled" : ""}>\${state.editingFlowId ? "Save Changes" : "Save Critical Flow"}</button>
                  \${duplicateMatches.length > 0 ? '<span class="meta">Save Anyway</span>' : ""}
                </div>
              </div>\`
            : ""}
            \${state.flows.length > 0 && !state.hasDescriptors ? \`
              <div class="callout">
                <p>We&apos;ll compare reviewed tests against these critical flows automatically.</p>
                <p>Next step: Capture and review a test run to start measuring coverage.</p>
                <div class="button-row"><a href="/critical-flows/capture-guide"><button type="button">Learn how to capture a test</button></a></div>
              </div>\`
            : ""}
          </div>\`;
      }

      function renderSelectedFlow(flow) {
        const missingTitle = flow.status === "partial" ? "Potential missing coverage" : "Potential missing coverage";
        const missingPanel = flow.missingTerms.length > 0
          ? \`
            <div class="list-block">
              <h3>\${escapeHtml(missingTitle)}</h3>
              <p class="meta">No reviewed test evidence currently matches:</p>
              <ul>\${summarizeItems(flow.missingTerms)}</ul>
              <p class="meta">These concepts were not found in reviewed descriptor vocabulary. This may indicate missing test coverage, missing reviewed runs, or vocabulary mismatch.</p>
            </div>\`
          : "";
        return \`
          <div class="stack">
            <div class="detail-header">
              <h2>\${escapeHtml(flow.name)}</h2>
              <p class="meta">Coverage status: <span class="status-chip \${escapeHtml(flow.status)}">\${escapeHtml(statusLabel(flow.status))}</span></p>
            </div>
            <div class="detail-block">
              <p><strong>Original raw text:</strong> \${escapeHtml(flow.rawText)}</p>
              <p><strong>Outcome:</strong> \${escapeHtml(flow.outcome || "-")}</p>
              <div class="button-row" style="margin-top: 14px;">
                <button type="button" id="editCriticalFlow">Edit</button>
                <button type="button" id="deleteCriticalFlow">Delete</button>
              </div>
            </div>
            <div class="grid">
              \${renderListBlock("Interpreted Steps", flow.interpretedSteps)}
              \${renderListBlock("Interpreted Terms", flow.interpretedTerms)}
              \${renderListBlock("Matched Concepts", flow.matchedConcepts)}
              \${missingPanel}
              \${renderListBlock("Matching Descriptors", flow.matchedDescriptors.map((descriptor) => descriptor.name))}
            </div>
            \${flow.status === "missing" ? '<p class="empty-note">No reviewed test evidence matches this critical flow yet.</p>' : ""}
          </div>\`;
      }

      function renderDetail() {
        const detail = document.getElementById("detail");
        const selectedFlow = state.flows.find((flow) => flow.id === state.selectedId);
        const hasFlows = state.flows.length > 0;
        detail.innerHTML =
          (hasFlows
            ? \`<div class="add-flow-bar"><button type="button" class="add-flow-button" id="openCriticalFlowForm">+ Add Critical Flow</button></div>\`
            : renderDraftArea()) +
          (selectedFlow ? renderSelectedFlow(selectedFlow) : "") +
          (hasFlows && state.showDraftForm
            ? \`<div class="modal-backdrop" id="criticalFlowModal" tabindex="-1">
                <div class="modal-card">
                  <div class="modal-shell">
                    <button type="button" class="modal-close" id="closeCriticalFlowModal" aria-label="Close critical flow form">×</button>
                    \${renderDraftArea({ compact: true })}
                  </div>
                </div>
              </div>\`
            : "");

        detail.querySelectorAll("[data-suggestion]").forEach((button) => {
          button.addEventListener("click", async () => {
            await interpretDraft(button.getAttribute("data-suggestion") || "");
          });
        });
        detail.querySelectorAll("[data-view-duplicate]").forEach((button) => {
          button.addEventListener("click", () => {
            const targetId = button.getAttribute("data-view-duplicate");
            if (!targetId) {
              return;
            }

            state.selectedId = targetId;
            state.showDraftForm = false;
            state.editingFlowId = null;
            state.parsedDraft = null;
            state.error = "";
            state.isWorking = false;
            render();
          });
        });

        detail.querySelector("#openCriticalFlowForm")?.addEventListener("click", () => {
          state.showDraftForm = true;
          state.editingFlowId = null;
          state.draftText = "";
          state.parsedDraft = null;
          state.error = "";
          render();
        });

        detail.querySelector("#cancelCriticalFlow")?.addEventListener("click", () => {
          state.showDraftForm = false;
          state.editingFlowId = null;
          state.parsedDraft = null;
          state.error = "";
          state.isWorking = false;
          render();
        });

        detail.querySelector("#closeCriticalFlowModal")?.addEventListener("click", () => {
          state.showDraftForm = false;
          state.editingFlowId = null;
          state.parsedDraft = null;
          state.error = "";
          state.isWorking = false;
          render();
        });

        detail.querySelector("#criticalFlowModal")?.addEventListener("click", (event) => {
          if (event.target.id !== "criticalFlowModal") {
            return;
          }

          state.showDraftForm = false;
          state.editingFlowId = null;
          state.parsedDraft = null;
          state.error = "";
          state.isWorking = false;
          render();
        });

        detail.querySelector("#criticalFlowModal")?.addEventListener("keydown", (event) => {
          if (event.key !== "Escape") {
            return;
          }

          state.showDraftForm = false;
          state.editingFlowId = null;
          state.parsedDraft = null;
          state.error = "";
          state.isWorking = false;
          render();
        });
        detail.querySelector("#criticalFlowModal")?.focus();

        detail.querySelector("#editCriticalFlow")?.addEventListener("click", () => {
          if (!selectedFlow) {
            return;
          }

          state.showDraftForm = true;
          state.editingFlowId = selectedFlow.id;
          state.draftText = selectedFlow.rawText;
          state.parsedDraft = {
            name: selectedFlow.name,
            rawText: selectedFlow.rawText,
            interpretedSteps: selectedFlow.interpretedSteps,
            interpretedTerms: selectedFlow.interpretedTerms,
            outcome: selectedFlow.outcome,
          };
          state.error = "";
          render();
        });

        detail.querySelector("#deleteCriticalFlow")?.addEventListener("click", async () => {
          if (!selectedFlow) {
            return;
          }

          const confirmed = window.confirm(\`Delete critical flow "\${selectedFlow.name}"?\`);
          if (!confirmed) {
            return;
          }

          const response = await fetch(\`/critical-flows/\${encodeURIComponent(selectedFlow.id)}\`, { method: "DELETE" });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            state.error = payload.error || "Unable to delete critical flow.";
            render();
            return;
          }

          state.showDraftForm = false;
          state.editingFlowId = null;
          state.parsedDraft = null;
          state.error = "";
          state.selectedId = state.flows.find((flow) => flow.id !== selectedFlow.id)?.id ?? null;
          await loadState();
        });

        detail.querySelector("#interpretFlow")?.addEventListener("click", async () => {
          const input = document.getElementById("criticalFlowInput");
          await interpretDraft(input.value);
        });

        detail.querySelector("#saveCriticalFlow")?.addEventListener("click", async () => {
          if (!state.parsedDraft) {
            return;
          }

          state.isWorking = true;
          state.error = "";
          render();

          try {
            const response = await fetch(
              state.editingFlowId ? \`/critical-flows/\${encodeURIComponent(state.editingFlowId)}\` : "/critical-flows",
              {
              method: state.editingFlowId ? "PUT" : "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(state.parsedDraft),
            });
            const payload = await response.json();
            if (!response.ok) {
              throw new Error(payload.error || "Unable to save critical flow.");
            }
            state.draftText = "";
            state.parsedDraft = null;
            state.isWorking = false;
            state.showDraftForm = false;
            state.editingFlowId = null;
            state.selectedId = payload.id;
            await loadState();
          } catch (error) {
            state.error = error instanceof Error ? error.message : "Unable to save critical flow.";
            state.isWorking = false;
            render();
          }
        });
      }

      function render() {
        renderGapSummary();
        renderList();
        renderDetail();
      }

      loadState();
    </script>
  </body>
</html>`;
}

function renderCaptureGuidePage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>What Did You Test? | Capture Guide</title>
    <style>
      body { font-family: "Iowan Old Style", "Palatino Linotype", serif; margin: 0; padding: 32px; background: #f6f1e7; color: #1d1a16; }
      main { max-width: 720px; margin: 0 auto; background: #fffdf8; border: 1px solid #d8cfbf; border-radius: 16px; padding: 24px; }
      a { color: #1f6f4a; font-weight: 600; }
    </style>
  </head>
  <body>
    <main>
      <h1>Learn How To Capture A Test</h1>
      <p>This route is a placeholder for the critical-flows onboarding path.</p>
      <p>TODO: Add product-specific guidance for capturing and reviewing the first test run.</p>
      <p><a href="/critical-flows">Back to Critical Flows</a></p>
    </main>
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
  const requestPath = req.url ? new URL(req.url, getServerUrl(req)).pathname : null;

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && requestPath === "/runs/start") {
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

  if (req.method === "POST" && requestPath === "/bindings/bind") {
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

  if (req.method === "GET" && requestPath === "/bindings/current") {
    const requestUrl = new URL(req.url ?? "/bindings/current", getServerUrl(req));
    const browserSessionId = requestUrl.searchParams.get("browserSessionId");

    if (!browserSessionId) {
      writeJson(res, 400, { error: "browserSessionId is required" });
      return;
    }

    const binding = getBoundRun(browserSessionId);
    writeJson(res, 200, binding ? { bound: true, ...binding } : { bound: false });
    return;
  }

  if (req.method === "POST" && requestPath === "/runs/end") {
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

  if (req.method === "POST" && requestPath === "/ingest") {
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

  if (req.method === "GET" && requestPath === "/bootstrap") {
    const requestUrl = new URL(req.url ?? "/bootstrap", getServerUrl(req));
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

  if (req.method === "GET" && requestPath === "/review") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderReviewPage());
    return;
  }

  if (req.method === "GET" && requestPath === "/review/summary") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderReviewSummaryPage());
    return;
  }

  if (req.method === "GET" && requestPath === "/critical-flows") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderCriticalFlowsPage());
    return;
  }

  if (req.method === "GET" && requestPath === "/critical-flows/capture-guide") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderCaptureGuidePage());
    return;
  }

  if (req.method === "GET" && requestPath === "/review/units") {
    writeJson(res, 200, await loadReviewUnits());
    return;
  }

  if (req.method === "GET" && requestPath === "/critical-flows/state") {
    writeJson(res, 200, await loadCriticalFlowState());
    return;
  }

  if (req.method === "GET" && requestPath === "/review/vocabulary") {
    writeJson(res, 200, await readJsonFile(getVocabularyPath(), []));
    return;
  }

  if (req.method === "PATCH" && requestPath?.startsWith("/review/units/")) {
    try {
      const reviewId = decodeURIComponent(requestPath.slice("/review/units/".length));
      const body = (await readJsonBody(req)) as
        | {
            descriptor?: string;
            notes?: string;
            vocab?: string[];
          }
        | null;

      if (!body || typeof body.descriptor !== "string") {
        writeJson(res, 400, { error: "Invalid review payload" });
        return;
      }

      const updated = await saveReviewUnitEdits({
        reviewId,
        descriptor: body.descriptor,
        notes: body.notes,
        vocab: Array.isArray(body.vocab) ? body.vocab : [],
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

  if (req.method === "POST" && requestPath?.startsWith("/review/units/") && requestPath.endsWith("/reprocess")) {
    try {
      const reviewId = decodeURIComponent(requestPath.slice("/review/units/".length, -"/reprocess".length));
      const updated = await requestReviewUnitReprocess(reviewId);

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

  if (req.method === "POST" && requestPath === "/review/vocabulary") {
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

  if (req.method === "POST" && requestPath === "/critical-flows/interpret") {
    try {
      const body = (await readJsonBody(req)) as { rawText?: string } | null;

      if (!body || typeof body.rawText !== "string") {
        writeJson(res, 400, { error: "Invalid critical flow payload" });
        return;
      }

      writeJson(res, 200, await parseCriticalFlow(body.rawText));
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      writeJson(res, 500, { error: message });
      return;
    }
  }

  if (req.method === "POST" && requestPath === "/critical-flows") {
    try {
      const body = await readJsonBody(req);

      if (
        !body ||
        typeof body.name !== "string" ||
        typeof body.rawText !== "string" ||
        !Array.isArray(body.interpretedSteps) ||
        !Array.isArray(body.interpretedTerms)
      ) {
        writeJson(res, 400, { error: "Invalid critical flow payload" });
        return;
      }

      writeJson(res, 201, await createCriticalFlow(body));
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      writeJson(res, 500, { error: message });
      return;
    }
  }

  if (req.method === "PUT" && requestPath?.startsWith("/critical-flows/")) {
    try {
      const criticalFlowId = decodeURIComponent(requestPath.slice("/critical-flows/".length));
      const body = await readJsonBody(req);

      if (
        !body ||
        typeof body.name !== "string" ||
        typeof body.rawText !== "string" ||
        !Array.isArray(body.interpretedSteps) ||
        !Array.isArray(body.interpretedTerms)
      ) {
        writeJson(res, 400, { error: "Invalid critical flow payload" });
        return;
      }

      const updated = await updateCriticalFlow(criticalFlowId, body);
      if (!updated) {
        writeJson(res, 404, { error: "Critical flow not found" });
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

  if (req.method === "DELETE" && requestPath?.startsWith("/critical-flows/")) {
    try {
      const criticalFlowId = decodeURIComponent(requestPath.slice("/critical-flows/".length));
      const deleted = await deleteCriticalFlow(criticalFlowId);
      if (!deleted) {
        writeJson(res, 404, { error: "Critical flow not found" });
        return;
      }

      writeJson(res, 200, { ok: true });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      writeJson(res, 500, { error: message });
      return;
    }
  }

  if (req.method === "GET" && requestPath === "/health") {
    writeJson(res, 200, { ok: true });
    return;
  }

  writeJson(res, 404, { error: "Not found" });
});

await ensureDataDir();
await refreshReviewUnits();

server.listen(PORT, HOST, () => {
  console.log(`WDYT server listening on http://${HOST}:${PORT}`);
});
