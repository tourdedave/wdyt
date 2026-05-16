import http from "node:http";
import { Buffer } from "node:buffer";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { DEFAULT_EXPORT_FILE_NAMES, exportArtifact } from "../artifact/exportArtifact.js";
import { importArtifactBuffers } from "../artifact/importArtifact.js";
import { DEFAULT_SERVER_URL } from "../shared/constants.js";
import {
  ensureDataDir,
  getCriticalFlowsPath,
  getProcessedRunsPath,
  getRawRunsPath,
  getReviewUnitsPath,
  getVocabularyPath,
  readJsonFile,
  readJsonLines,
} from "../shared/fs.js";
import type { BrowserInfo, RunEnvironment } from "../shared/types.js";
import { validateIngestPayload } from "../shared/validation.js";
import { createCriticalFlow, deleteCriticalFlow, loadCriticalFlowState, parseCriticalFlow, updateCriticalFlow } from "./critical-flows.js";
import { loadReviewUnits, loadReviewUnitViews, refreshReviewUnits, requestReviewUnitReprocess, saveReviewUnitEdits, upsertVocabulary } from "./review.js";
import { persistRun } from "./storage.js";

const HOST = process.env.WDYT_HOST ?? "127.0.0.1";
const PORT = Number(process.env.WDYT_PORT ?? "3876");
const EXPECTED_BEHAVIORS_PATH = "/expected-behaviors";
const GETTING_STARTED_PATH = "/getting-started";

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

async function hasAnyRuntimeData() {
  const [rawRuns, processedRuns, reviewUnits, criticalFlows] = await Promise.all([
    readJsonLines(getRawRunsPath()),
    readJsonLines(getProcessedRunsPath()),
    readJsonFile(getReviewUnitsPath(), []),
    readJsonFile(getCriticalFlowsPath(), []),
  ]);

  return rawRuns.length > 0 || processedRuns.length > 0 || reviewUnits.length > 0 || criticalFlows.length > 0;
}

function getServerUrl(req: http.IncomingMessage) {
  const host = req.headers.host;
  return host ? `http://${host}` : DEFAULT_SERVER_URL;
}

function renderEmptyStatePage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Get started with wdyt</title>
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
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Iowan Old Style", "Palatino Linotype", serif; color: var(--ink); background: linear-gradient(180deg, #f0eadc 0%, var(--bg) 100%); }
      main { min-height: 100vh; padding: 40px 24px; }
      .shell { max-width: 1120px; margin: 0 auto; }
      h1 { margin: 0 0 28px; font-size: 40px; line-height: 1.1; }
      .launchpad { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 24px; align-items: stretch; }
      .panel { background: rgba(255,253,248,0.92); border: 1px solid var(--line); border-radius: 18px; padding: 28px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.55); }
      .panel h2 { margin: 0 0 12px; font-size: 28px; }
      .panel p { margin: 0 0 14px; color: var(--muted); line-height: 1.5; font-size: 17px; }
      .panel p.helper { margin-top: 18px; font-size: 15px; }
      .button-link,
      .picker-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 44px;
        padding: 10px 18px;
        border-radius: 999px;
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #fff;
        text-decoration: none;
        font-weight: 700;
        cursor: pointer;
      }
      .button-link:hover,
      .picker-button:hover { background: #195d3f; }
      .divider {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--muted);
        font-size: 14px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .dropzone {
        margin-top: 12px;
        padding: 28px 20px;
        border: 2px dashed rgba(31,111,74,0.24);
        border-radius: 16px;
        background: rgba(255,255,255,0.55);
        text-align: center;
        transition: border-color 120ms ease, background 120ms ease;
      }
      .dropzone.dragover {
        border-color: var(--accent);
        background: rgba(31,111,74,0.08);
      }
      .dropzone p { margin: 0 0 14px; font-size: 16px; }
      .upload-actions { margin-top: 14px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
      .secondary-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 44px;
        padding: 10px 18px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: transparent;
        color: var(--ink);
        text-decoration: none;
        font-weight: 700;
        cursor: pointer;
      }
      .secondary-button:hover { background: rgba(255,255,255,0.6); }
      .upload-button[disabled],
      .secondary-button[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .selected-files {
        margin-top: 14px;
        padding: 14px 16px;
        border: 1px solid rgba(216,207,191,0.9);
        border-radius: 14px;
        background: rgba(255,255,255,0.5);
      }
      .selected-files strong {
        display: block;
        margin-bottom: 8px;
      }
      .selected-files ul {
        margin: 0;
        padding-left: 18px;
        color: var(--muted);
      }
      .selected-files li + li { margin-top: 4px; }
      .meta { margin-top: 12px; color: var(--muted); font-size: 14px; min-height: 20px; }
      .error { color: #9f1d1d; }
      input[type="file"] { display: none; }
      @media (max-width: 900px) {
        .launchpad { grid-template-columns: 1fr; }
        .divider { margin: -6px 0; }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="shell">
        <h1>Get started with wdyt</h1>
        <div class="launchpad">
          <section class="panel">
            <h2>Capture test data</h2>
            <p>Run your tests with wdyt enabled to capture behavior and generate an artifact.</p>
            <a class="button-link" href="${GETTING_STARTED_PATH}" target="_blank" rel="noreferrer">View Getting Started guide</a>
            <p class="helper">After running your tests, you’ll be able to review observed behaviors and evaluate coverage.</p>
          </section>

          <div class="divider">OR</div>

          <section class="panel">
            <h2>Upload an artifact</h2>
            <p>Already have wdyt output? Upload one or more artifact (.zip) files to review and analyze.</p>
            <div id="dropzone" class="dropzone" tabindex="0">
              <p>Drag and drop artifact (.zip) files here</p>
              <label class="picker-button" for="artifactFiles">Select files</label>
              <input id="artifactFiles" type="file" accept=".zip,application/zip" multiple />
            </div>
            <div id="selectedFiles" class="selected-files" hidden></div>
            <div class="upload-actions">
              <button id="uploadArtifacts" class="picker-button upload-button" type="button" disabled>Upload selected files</button>
              <button id="clearArtifacts" class="secondary-button" type="button" disabled>Clear selection</button>
            </div>
            <div id="uploadStatus" class="meta"></div>
          </section>
        </div>
      </div>
    </main>
    <script>
      const dropzone = document.getElementById("dropzone");
      const fileInput = document.getElementById("artifactFiles");
      const selectedFilesEl = document.getElementById("selectedFiles");
      const uploadButton = document.getElementById("uploadArtifacts");
      const clearButton = document.getElementById("clearArtifacts");
      const statusEl = document.getElementById("uploadStatus");
      let selectedFiles = [];

      const setStatus = (message, isError = false) => {
        statusEl.textContent = message;
        statusEl.className = isError ? "meta error" : "meta";
      };

      const getFileKey = (file) => [file.name, file.size, file.lastModified].join("::");

      const renderSelectedFiles = () => {
        if (selectedFiles.length === 0) {
          selectedFilesEl.hidden = true;
          selectedFilesEl.innerHTML = "";
          uploadButton.disabled = true;
          clearButton.disabled = true;
          return;
        }

        selectedFilesEl.hidden = false;
        selectedFilesEl.innerHTML = \`
          <strong>\${selectedFiles.length} artifact\${selectedFiles.length === 1 ? "" : "s"} selected</strong>
          <ul>\${selectedFiles.map((file) => \`<li>\${file.name}</li>\`).join("")}</ul>
        \`;
        uploadButton.disabled = false;
        clearButton.disabled = false;
      };

      const addFiles = (files) => {
        const zipFiles = [...(files || [])].filter((file) => file.name.toLowerCase().endsWith(".zip"));
        if (zipFiles.length === 0) {
          setStatus("Select one or more artifact (.zip) files.", true);
          return;
        }

        const nextFiles = new Map(selectedFiles.map((file) => [getFileKey(file), file]));
        zipFiles.forEach((file) => {
          nextFiles.set(getFileKey(file), file);
        });
        selectedFiles = [...nextFiles.values()];
        renderSelectedFiles();
        setStatus(\`\${selectedFiles.length} artifact\${selectedFiles.length === 1 ? "" : "s"} ready to upload.\`);
      };

      const toBase64 = async (file) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        return btoa(binary);
      };

      const importFiles = async () => {
        if (selectedFiles.length === 0) {
          setStatus("Select one or more artifact (.zip) files.", true);
          return;
        }

        setStatus(\`Uploading \${selectedFiles.length} artifact\${selectedFiles.length === 1 ? "" : "s"}…\`);
        uploadButton.disabled = true;
        clearButton.disabled = true;

        try {
          const payload = {
            files: await Promise.all(selectedFiles.map(async (file) => ({
              name: file.name,
              contentBase64: await toBase64(file),
            }))),
          };

          const response = await fetch("/artifacts/import", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          const body = await response.json();
          if (!response.ok) {
            throw new Error(body.error || "Unable to import artifacts.");
          }

          setStatus("Artifacts imported. Opening observed behaviors…");
          window.location.assign("/review");
        } catch (error) {
          renderSelectedFiles();
          setStatus(error instanceof Error ? error.message : "Unable to import artifacts.", true);
        }
      };

      fileInput.addEventListener("change", () => {
        addFiles(fileInput.files);
        fileInput.value = "";
      });

      uploadButton.addEventListener("click", () => {
        importFiles();
      });

      clearButton.addEventListener("click", () => {
        selectedFiles = [];
        renderSelectedFiles();
        setStatus("");
      });

      ["dragenter", "dragover"].forEach((eventName) => {
        dropzone.addEventListener(eventName, (event) => {
          event.preventDefault();
          dropzone.classList.add("dragover");
        });
      });

      ["dragleave", "drop"].forEach((eventName) => {
        dropzone.addEventListener(eventName, (event) => {
          event.preventDefault();
          dropzone.classList.remove("dragover");
        });
      });

      dropzone.addEventListener("drop", (event) => {
        addFiles(event.dataTransfer.files);
      });
    </script>
  </body>
</html>`;
}

function renderBootstrapPage(payload: {
  action: "start" | "finalize";
  serverUrl: string;
  suiteName?: string;
  testName?: string;
  environment?: RunEnvironment;
  reason?: "completed" | "timeout";
}) {
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
      const payload = ${JSON.stringify(payload)};

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

      if (!payload.serverUrl || !payload.action) {
        finish("error", "Missing bootstrap parameters");
      } else {
        const timeoutId = setTimeout(() => {
          if (!resolved) {
            finish("error", "WDYT bind timed out", "No response from content script bridge");
          }
        }, 5000);

        const kind = payload.action === "start" ? "WDYT_BEGIN_CAPTURE" : "WDYT_FINALIZE_CAPTURE";
        const bindIntervalId = setInterval(() => {
          if (resolved) {
            clearInterval(bindIntervalId);
            return;
          }

          window.postMessage({ kind, ...payload }, "*");
        }, 250);

        window.addEventListener("message", (event) => {
          if (event.source !== window || !event.data || event.data.kind !== "WDYT_CAPTURE_RESULT") {
            return;
          }

          if (event.data.ok) {
            clearTimeout(timeoutId);
            clearInterval(bindIntervalId);
            finish(
              "ok",
              payload.action === "start" ? "WDYT capture started" : "WDYT capture finalized",
              \`browserSessionId=\${event.data.browserSessionId}\`
            );
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
      header { padding: 20px 24px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,0.6); backdrop-filter: blur(10px); }
      .header-bar { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
      .header-copy { min-width: 0; }
      .header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
      header h1 { margin: 0; font-size: 30px; }
      header h1 a { color: inherit; text-decoration: none; }
      header h1 a:hover { text-decoration: underline; }
      header p { margin: 6px 0 0; color: var(--muted); }
      nav { margin-top: 10px; display: flex; gap: 12px; flex-wrap: wrap; }
      nav a { color: var(--accent); text-decoration: none; font-weight: 600; }
      nav a.active { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
      .settings-menu { position: relative; }
      .settings-menu[open] { z-index: 40; }
      .settings-trigger {
        list-style: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border-radius: 999px;
        padding: 10px 16px;
        background: var(--accent);
        color: #fff;
        text-decoration: none;
        font-weight: 600;
        white-space: nowrap;
        cursor: pointer;
      }
      .settings-trigger:hover { background: #195d3f; }
      .settings-trigger::-webkit-details-marker { display: none; }
      .settings-panel {
        position: absolute;
        top: calc(100% + 10px);
        right: 0;
        z-index: 41;
        min-width: 240px;
        padding: 8px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(255,253,248,0.98);
        box-shadow: 0 10px 30px rgba(29,26,22,0.12);
      }
      .settings-option {
        display: block;
        width: 100%;
        padding: 10px 12px;
        border: none;
        border-radius: 10px;
        color: var(--ink);
        background: transparent;
        text-align: left;
        font-size: 15px;
        line-height: 1.35;
        cursor: pointer;
      }
      .settings-option:hover {
        background: rgba(31,111,74,0.08);
      }
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
      @media (max-width: 900px) {
        main { grid-template-columns: 1fr; }
        aside { border-right: 0; border-bottom: 1px solid var(--line); }
        .grid { grid-template-columns: 1fr; }
        .settings-panel { right: auto; left: 0; }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="header-bar">
        <div class="header-copy">
          <h1><a href="/review/summary">What Did You Test?</a></h1>
          <p>Review and refine observed behaviors before evaluating coverage.</p>
          <nav>
            <a class="active" href="/review">Observed Behaviors</a>
            <a href="${EXPECTED_BEHAVIORS_PATH}">Expected Behaviors</a>
            <a href="/review/summary">Summary</a>
          </nav>
        </div>
        <div class="header-actions">
          <details class="settings-menu" id="reviewSettingsMenu">
            <summary class="settings-trigger">Settings <span aria-hidden="true">▾</span></summary>
            <div class="settings-panel">
              <button type="button" class="settings-option" id="rebuildReviewUnits">Rebuild Observed Behaviors</button>
            </div>
          </details>
        </div>
      </div>
    </header>
    <main>
      <aside><div id="overlapSummary"></div><div id="units"></div></aside>
      <section><div id="detail" class="panel"><p id="empty">Select a flow variant to review.</p></div></section>
    </main>
    <script>
      let state = { units: [], vocabulary: [], selectedId: null, editingId: null, submittingReviewId: null, transitionMessage: "", pendingFocusHeading: false, activeOverlapKey: null, rebuilding: false };
      const summarize = (value) => Array.isArray(value) && value.length > 0 ? value.join(", ") : "-";
      const escapeHtml = (value) => String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
      const getActiveUnits = () => state.units.filter((unit) => unit.proposalState === "proposed" || unit.activeDescriptor);
      const getOverlapVocab = (unit) => Array.isArray(unit.overlapTerms) ? unit.overlapTerms : [];
      const getDescriptorKey = (unit) => String(unit.activeDescriptor || unit.proposedDescriptor || "").trim().toLowerCase();
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
      const isSubsetOverlapMatch = (leftUnit, rightUnit) => {
        const leftDescriptor = getDescriptorKey(leftUnit);
        const rightDescriptor = getDescriptorKey(rightUnit);
        if (!leftDescriptor || leftDescriptor !== rightDescriptor) {
          return false;
        }

        const left = getOverlapVocab(leftUnit);
        const right = getOverlapVocab(rightUnit);
        const shared = getSharedOverlapCount(left, right);
        const minCount = Math.min(left.length, right.length);
        return minCount > 0 && shared === minCount;
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
            group.units.some((candidate) => isOverlapMatch(vocab, getOverlapVocab(candidate)) || isSubsetOverlapMatch(unit, candidate))
          );

          if (matchedGroup) {
            matchedGroup.units.push(unit);
            matchedGroup.vocab = [...new Set([...matchedGroup.vocab, ...vocab])].sort();
            matchedGroup.key = matchedGroup.vocab.join("||");
            return;
          }

          groups.push({
            key: [...vocab].sort().join("||"),
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
      const getCardStatus = (unit) => {
        if (unit.proposalState === "processing") return "generating proposal";
        if (unit.proposalState === "error") return "proposal failed";
        return null;
      };
      const redirectToLaunchpad = () => {
        window.location.assign("/review");
      };

      async function loadState() {
        const params = new URLSearchParams(window.location.search);
        const initialReviewId = params.get("reviewId");
        const initialOverlapKey = params.get("overlapKey");
        const [unitsRes, vocabRes, runtimeRes] = await Promise.all([
          fetch("/review/units"),
          fetch("/review/vocabulary"),
          fetch("/runtime/state"),
        ]);
        const nextUnits = await unitsRes.json();
        state.vocabulary = await vocabRes.json();
        const runtimeState = await runtimeRes.json();
        if (!runtimeState.hasData) {
          redirectToLaunchpad();
          return;
        }
        if (state.editingId && nextUnits.some((unit) => unit.reviewId === state.editingId)) {
          state.units = nextUnits;
          renderList();
          return;
        }
        state.units = nextUnits;
        const activeUnits = getActiveUnits();
        const overlapGroups = getOverlapGroups();
        if (initialOverlapKey && overlapGroups.some((group) => group.key === initialOverlapKey)) {
          state.activeOverlapKey = initialOverlapKey;
          if (!initialReviewId) {
            state.selectedId = overlapGroups.find((group) => group.key === initialOverlapKey)?.units[0]?.reviewId ?? state.selectedId;
          }
        }
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
            \${getCardStatus(unit) ? \`<div class="status">\${escapeHtml(getCardStatus(unit))}</div>\` : ""}
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
            \${renderListBlock("Prerequisites", unit.prerequisites)}
            \${renderListBlock("Primary Terms", unit.primaryTerms)}
            \${renderListBlock("Flow Steps", unit.canonical)}
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

      document.getElementById("rebuildReviewUnits")?.addEventListener("click", async () => {
        if (state.rebuilding) {
          return;
        }

        const settingsMenu = document.getElementById("reviewSettingsMenu");
        if (settingsMenu && "open" in settingsMenu) {
          settingsMenu.open = false;
        }

        state.rebuilding = true;
        state.transitionMessage = "Rebuilding observed behaviors from captured evidence…";
        render();

        try {
          const response = await fetch("/review/rebuild", { method: "POST" });
          if (!response.ok) {
            throw new Error("Unable to rebuild observed behaviors.");
          }

          state.selectedId = null;
          state.activeOverlapKey = null;
          state.pendingFocusHeading = false;
          await loadState();
          state.transitionMessage = "Observed behaviors rebuilt from captured evidence.";
          render();
          setTimeout(() => {
            state.transitionMessage = "";
            render();
          }, 1600);
        } catch (error) {
          state.transitionMessage = error instanceof Error ? error.message : "Unable to rebuild observed behaviors.";
          render();
        } finally {
          state.rebuilding = false;
          render();
        }
      });

      function render() {
        const rebuildButton = document.getElementById("rebuildReviewUnits");
        if (rebuildButton) {
          rebuildButton.disabled = state.rebuilding;
          rebuildButton.textContent = state.rebuilding ? "Rebuilding…" : "Rebuild Observed Behaviors";
        }
        renderOverlapSummary();
        renderList();
        renderDetail();
      }
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
    <title>What Did You Test? | Summary</title>
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
      html { scroll-behavior: smooth; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Iowan Old Style", "Palatino Linotype", serif; background: linear-gradient(180deg, #f0eadc 0%, var(--bg) 100%); color: var(--ink); }
      header { padding: 20px 24px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,0.6); backdrop-filter: blur(10px); position: relative; z-index: 30; isolation: isolate; }
      .header-shell { position: relative; z-index: 1; }
      header h1 { margin: 0; font-size: 30px; }
      header h1 a { color: inherit; text-decoration: none; }
      header h1 a:hover { text-decoration: underline; }
      header p { margin: 6px 0 0; color: var(--muted); }
      nav { margin-top: 10px; display: flex; gap: 12px; flex-wrap: wrap; }
      nav a { color: var(--accent); text-decoration: none; font-weight: 600; }
      nav a.active { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
      .export-menu { position: absolute; top: 50%; right: 0; transform: translateY(-50%); z-index: 31; }
      .export-menu[open] { z-index: 40; }
      .export-trigger {
        list-style: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border-radius: 999px;
        padding: 10px 16px;
        background: var(--accent);
        color: #fff;
        text-decoration: none;
        font-weight: 600;
        white-space: nowrap;
        cursor: pointer;
      }
      .export-trigger:hover { background: #195d3f; }
      .export-trigger::-webkit-details-marker { display: none; }
      .export-panel {
        position: absolute;
        top: calc(100% + 10px);
        right: 0;
        z-index: 41;
        min-width: 220px;
        padding: 8px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(255,253,248,0.98);
        box-shadow: 0 10px 30px rgba(29,26,22,0.12);
      }
      .export-option {
        display: block;
        padding: 10px 12px;
        border-radius: 10px;
        color: var(--ink);
        text-decoration: none;
        font-size: 15px;
        line-height: 1.35;
      }
      .export-option:hover {
        background: rgba(31,111,74,0.08);
      }
      main { padding: 24px 24px 48px; display: grid; gap: 14px; }
      .hero { display: grid; gap: 8px; }
      .hero h2 { margin: 0; font-size: 34px; }
      .hero p { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.35; max-width: 760px; }
      .summary-stack { display: grid; gap: 30px; }
      .kpi-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
      .kpi-card { display: block; background: linear-gradient(180deg, #fffefb 0%, #f7efe1 100%); border: 1px solid #c8bba6; border-radius: 12px; padding: 10px 12px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.75); position: relative; overflow: hidden; color: inherit; text-decoration: none; cursor: pointer; transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease, background 120ms ease; }
      .kpi-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: transparent; }
      .kpi-card:hover { transform: translateY(-1px); border-color: #bba98e; box-shadow: inset 0 1px 0 rgba(255,255,255,0.75), 0 6px 16px rgba(29,26,22,0.06); background: linear-gradient(180deg, #fffefc 0%, #f9f1e6 100%); }
      .kpi-label { color: var(--muted); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 4px; font-weight: 700; }
      .kpi-value { font-size: 29px; font-weight: 700; line-height: 1; }
      .kpi-card.covered::before { background: rgba(31,111,74,0.24); }
      .kpi-card.covered .kpi-value { color: var(--accent); }
      .kpi-card.partial::before,
      .kpi-card.repeated::before { background: rgba(183,110,27,0.24); }
      .kpi-card.partial .kpi-value,
      .kpi-card.repeated .kpi-value { color: var(--warn); }
      .kpi-card.missing::before { background: rgba(159,29,29,0.22); }
      .kpi-card.missing .kpi-value { color: var(--danger); }
      .section-card { background: rgba(255,253,248,0.9); border: 1px solid var(--line); border-radius: 18px; padding: 12px 14px; position: relative; box-shadow: inset 0 1px 0 rgba(255,255,255,0.55); scroll-margin-top: 20px; }
      .section-card::before { content: ""; position: absolute; top: -16px; left: 10px; right: 10px; border-top: 1px solid rgba(216,207,191,0.95); }
      .section-card:first-child::before { display: none; }
      .section-header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid rgba(216,207,191,0.65); }
      .section-header h3 { margin: 0; font-size: 24px; }
      .section-note { margin: 0 0 10px; color: var(--muted); font-size: 14px; line-height: 1.4; }
      .metric-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
      .metric-chip { padding: 5px 9px; border-radius: 999px; background: #f3ecdf; font-size: 12px; }
      button.metric-chip { border: 1px solid transparent; cursor: pointer; font: inherit; transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease; }
      button.metric-chip:hover { transform: translateY(-1px); border-color: rgba(138,90,24,0.18); box-shadow: 0 2px 10px rgba(29,26,22,0.06); }
      button.metric-chip.active { border-color: rgba(29,26,22,0.16); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.55); }
      .metric-chip.all { color: var(--ink); background: #efe7d9; }
      .metric-chip.covered { color: var(--accent); background: rgba(31,111,74,0.12); }
      .metric-chip.partial { color: var(--warn); background: rgba(183,110,27,0.14); }
      .metric-chip.missing { color: var(--danger); background: rgba(159,29,29,0.12); }
      .empty-note, .meta { color: var(--muted); }
      .concept-list, .repeat-list { display: grid; gap: 6px; }
      .concept-link, .repeat-link { display: block; text-decoration: none; color: inherit; border: 1px solid var(--line); border-radius: 11px; padding: 8px 10px; background: #fff; }
      .concept-link:hover, .repeat-link:hover { border-color: var(--accent-2); box-shadow: 0 0 0 2px rgba(138,90,24,0.12); }
      .concept-title, .repeat-title { font-size: 16px; font-weight: 700; margin-bottom: 1px; line-height: 1.25; }
      .repeat-meta, .concept-meta { color: var(--muted); font-size: 12px; line-height: 1.25; }
      .repeat-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .flow-summary-list { display: grid; gap: 6px; }
      .flow-summary-card { display: block; border: 1px solid var(--line); border-radius: 11px; padding: 8px 10px; background: #fff; color: inherit; text-decoration: none; }
      .flow-summary-card:hover { border-color: var(--accent-2); box-shadow: 0 0 0 2px rgba(138,90,24,0.12); }
      .flow-summary-title { font-size: 16px; font-weight: 700; line-height: 1.25; margin-bottom: 2px; }
      .flow-summary-meta { color: var(--muted); font-size: 12px; line-height: 1.25; }
      .flow-summary-meta.covered { color: var(--accent); }
      .flow-summary-meta.partial { color: var(--warn); }
      .flow-summary-meta.missing { color: var(--danger); }
      .unique-list { display: grid; gap: 4px; }
      .unique-item { display: flex; align-items: flex-start; gap: 8px; padding: 1px 0; }
      .unique-bullet { color: var(--accent-2); font-size: 16px; line-height: 1.35; }
      .unique-link { color: inherit; text-decoration: none; font-size: 17px; line-height: 1.35; }
      .unique-link:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
      .back { color: var(--accent); text-decoration: none; font-weight: 600; }
      @media (max-width: 900px) {
        .export-menu { position: static; transform: none; margin-top: 12px; }
        .export-panel { right: auto; left: 0; }
        .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .repeat-list { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="header-shell">
        <div class="header-bar">
          <div class="header-copy">
            <h1><a href="/review/summary">What Did You Test?</a></h1>
            <p>See what was exercised based on observed evidence, and evaluate coverage of critical business flows.</p>
            <nav>
              <a href="/review">Observed Behaviors</a>
              <a href="${EXPECTED_BEHAVIORS_PATH}">Expected Behaviors</a>
              <a class="active" href="/review/summary">Summary</a>
            </nav>
          </div>
        </div>
        <details class="export-menu">
          <summary class="export-trigger">Export <span aria-hidden="true">▾</span></summary>
          <div class="export-panel">
            <a class="export-option" href="/artifacts/export?format=pdf">Download PDF report</a>
            <a class="export-option" href="/artifacts/export?format=zip">Download artifact (.zip)</a>
          </div>
        </details>
      </div>
    </header>
    <main>
      <div id="summary">Loading…</div>
    </main>
    <script>
      const exportMenu = document.querySelector(".export-menu");
      if (exportMenu) {
        document.addEventListener("click", (event) => {
          if (!exportMenu.contains(event.target)) {
            exportMenu.removeAttribute("open");
          }
        });
        exportMenu.querySelectorAll(".export-option").forEach((link) => {
          link.addEventListener("click", () => {
            exportMenu.removeAttribute("open");
          });
        });
      }

      const escapeHtml = (value) => String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
      const getActiveUnits = (units) => units.filter((unit) => unit.proposalState === "proposed" && (unit.activeDescriptor || unit.proposedDescriptor));
      const getOverlapVocab = (unit) => Array.isArray(unit.overlapTerms) ? unit.overlapTerms : [];
      const getDescriptorKey = (unit) => String(unit.activeDescriptor || unit.proposedDescriptor || "").trim().toLowerCase();
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
      const isSubsetOverlapMatch = (leftUnit, rightUnit) => {
        const leftDescriptor = getDescriptorKey(leftUnit);
        const rightDescriptor = getDescriptorKey(rightUnit);
        if (!leftDescriptor || leftDescriptor !== rightDescriptor) {
          return false;
        }

        const left = getOverlapVocab(leftUnit);
        const right = getOverlapVocab(rightUnit);
        const shared = getSharedOverlapCount(left, right);
        const minCount = Math.min(left.length, right.length);
        return minCount > 0 && shared === minCount;
      };
      const getOverlapGroups = (units) => {
        const groups = [];
        getActiveUnits(units)
          .slice()
          .sort((a, b) => getOverlapVocab(a).length - getOverlapVocab(b).length || a.reviewId.localeCompare(b.reviewId))
          .forEach((unit) => {
            const vocab = getOverlapVocab(unit);
            if (vocab.length === 0) {
              return;
            }

            const matchedGroup = groups.find((group) =>
              group.units.some((candidate) => isOverlapMatch(vocab, getOverlapVocab(candidate)) || isSubsetOverlapMatch(unit, candidate))
            );

            if (matchedGroup) {
              matchedGroup.units.push(unit);
              matchedGroup.vocab = [...new Set([...matchedGroup.vocab, ...vocab])].sort();
              matchedGroup.key = matchedGroup.vocab.join("||");
              return;
            }

            groups.push({
              key: [...vocab].sort().join("||"),
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
      const getGapSummary = (flows) => {
        const summary = new Map();
        flows.forEach((flow) => {
          (flow.missingTerms || []).forEach((term) => {
            const current = summary.get(term) || [];
            current.push(flow);
            summary.set(term, current);
          });
        });

        return [...summary.entries()]
          .map(([term, relatedFlows]) => ({ term, flows: relatedFlows.sort((a, b) => a.name.localeCompare(b.name)) }))
          .sort((a, b) => b.flows.length - a.flows.length || a.term.localeCompare(b.term));
      };
      const getFlowStatusText = (flow) => {
        if (flow.status === "covered") {
          return "✅ Covered";
        }
        if (flow.status === "partial") {
          const missing = (flow.missingQualifiers || []).filter(Boolean);
          return missing.length > 0
            ? \`⚠️ Partially Covered — missing qualifiers: \${missing.map((term) => term.replaceAll("_", " ")).join(", ")}\`
            : "⚠️ Partially Covered";
        }
        return "❌ Not Covered — no evidence of this behavior in test execution";
      };
      const redirectToLaunchpad = () => {
        window.location.assign("/review");
      };
      const getUniqueFlows = (units, overlapGroups) => {
        const clusteredIds = new Set(overlapGroups.flatMap((group) => group.units.map((unit) => unit.reviewId)));
        const representatives = overlapGroups.map((group) => ({
          kind: "cluster",
          key: group.key,
          title: getOverlapTitle(group),
          count: group.units.length,
          reviewId: group.units[0]?.reviewId || "",
          prerequisites: [...new Set(group.units.flatMap((unit) => unit.prerequisites || []))].sort(),
        }));
        const singletons = getActiveUnits(units)
          .filter((unit) => !clusteredIds.has(unit.reviewId))
          .map((unit) => ({
            kind: "unit",
            reviewId: unit.reviewId,
            title: unit.activeDescriptor || unit.proposedDescriptor || unit.canonical.join(" → "),
            count: 1,
            prerequisites: unit.prerequisites || [],
          }));
        return [...representatives, ...singletons].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
      };
      const formatUniqueFlowLabel = (item) =>
        item.count > 1 ? \`\${item.title} (\${item.count})\` : item.title;
      const renderKpiCard = (label, value, href, tone = "", filter = "") => \`
        <a class="kpi-card \${escapeHtml(tone)}" href="\${escapeHtml(href)}" \${filter ? \`data-kpi-filter="\${escapeHtml(filter)}"\` : ""}>
          <div class="kpi-label">\${escapeHtml(label)}</div>
          <div class="kpi-value">\${escapeHtml(String(value))}</div>
        </a>\`;

      async function loadSummary() {
        const [units, criticalFlowState, runtimeState] = await Promise.all([
          fetch("/review/units").then((response) => response.json()),
          fetch("${EXPECTED_BEHAVIORS_PATH}/state").then((response) => response.json()),
          fetch("/runtime/state").then((response) => response.json()),
        ]);
        if (!runtimeState.hasData) {
          redirectToLaunchpad();
          return;
        }
        const activeUnits = getActiveUnits(units);
        const overlapGroups = getOverlapGroups(units);
        const uniqueFlows = getUniqueFlows(units, overlapGroups);
        const criticalFlows = criticalFlowState.flows || [];
        const coveredCount = criticalFlows.filter((flow) => flow.status === "covered").length;
        const partialCount = criticalFlows.filter((flow) => flow.status === "partial").length;
        const missingCount = criticalFlows.filter((flow) => flow.status === "not_covered").length;
        const target = document.getElementById("summary");
        let coverageFilter = "all";

        if (activeUnits.length === 0 && criticalFlows.length === 0) {
          target.innerHTML = "<p class='empty-note'>No interpreted review units or critical flows yet.</p>";
          return;
        }

        const renderSummary = () => {
          const filteredFlows = criticalFlows
            .filter((flow) => coverageFilter === "all" ? true : flow.status === coverageFilter)
            .sort((a, b) => a.name.localeCompare(b.name));

          target.innerHTML = \`
            <div class="summary-stack">
              <div class="kpi-grid">
              \${renderKpiCard("Observed Behaviors", uniqueFlows.length, "#unique-flows-observed")}
              \${criticalFlows.length > 0 ? renderKpiCard("Covered", coveredCount, "#critical-flow-coverage", coveredCount > 0 ? "covered" : "", "covered") : ""}
              \${criticalFlows.length > 0 ? renderKpiCard("Partial", partialCount, "#critical-flow-coverage", partialCount > 0 ? "partial" : "", "partial") : ""}
              \${criticalFlows.length > 0 ? renderKpiCard("Missing", missingCount, "#critical-flow-coverage", missingCount > 0 ? "missing" : "", "not_covered") : ""}
            </div>

              <section id="unique-flows-observed" class="section-card">
              <div class="section-header">
                <h3>Observed Behaviors</h3>
              </div>
              <p class="section-note">Behaviors exercised during testing. Counts indicate repeated coverage across multiple test scenarios.</p>
              \${uniqueFlows.length > 0 ? \`
                <div class="unique-list">
                  \${uniqueFlows.map((item) => \`
                    <div class="unique-item">
                      <span class="unique-bullet">•</span>
                      \${item.kind === "cluster"
                        ? \`<a class="unique-link" href="/review?reviewId=\${encodeURIComponent(item.reviewId)}&overlapKey=\${encodeURIComponent(item.key)}">\${escapeHtml(formatUniqueFlowLabel(item))}</a>\`
                        : \`<a class="unique-link" href="/review?reviewId=\${encodeURIComponent(item.reviewId)}">\${escapeHtml(formatUniqueFlowLabel(item))}</a>\`}
                    </div>\`).join("")}
                </div>
              \`
              : '<p class="empty-note">No observed behaviors yet.</p>'}
              </section>

              <section id="critical-flow-coverage" class="section-card">
              <div class="section-header">
                <h3>Coverage Against Expected Behaviors</h3>
              </div>
              <div class="metric-row">
                <button class="metric-chip all \${coverageFilter === "all" ? "active" : ""}" data-coverage-filter="all">All: \${escapeHtml(String(criticalFlows.length))}</button>
                <button class="metric-chip covered \${coverageFilter === "covered" ? "active" : ""}" data-coverage-filter="covered">Covered: \${escapeHtml(String(coveredCount))}</button>
                <button class="metric-chip partial \${coverageFilter === "partial" ? "active" : ""}" data-coverage-filter="partial">Partial: \${escapeHtml(String(partialCount))}</button>
                <button class="metric-chip missing \${coverageFilter === "not_covered" ? "active" : ""}" data-coverage-filter="not_covered">Missing: \${escapeHtml(String(missingCount))}</button>
              </div>
              \${filteredFlows.length > 0 ? \`
                <div class="flow-summary-list">
                  \${filteredFlows.map((flow) => \`
                    <a class="flow-summary-card" href="${EXPECTED_BEHAVIORS_PATH}?flowId=\${encodeURIComponent(flow.id)}">
                      <div class="flow-summary-title">\${escapeHtml(flow.name)}</div>
                      <div class="flow-summary-meta \${escapeHtml(flow.status)}">\${escapeHtml(getFlowStatusText(flow))}</div>
                    </a>\`).join("")}
                </div>\`
              : criticalFlows.length === 0
                ? '<p class="empty-note">No expected behaviors defined.</p><p class="empty-note">Define expected behaviors to evaluate coverage against what was exercised.</p><p><a class="back" href="${EXPECTED_BEHAVIORS_PATH}">Define Expected Behaviors</a></p>'
                : '<p class="empty-note">No critical flows match this filter.</p>'}
              </section>
            </div>\`;

          target.querySelectorAll("[data-coverage-filter]").forEach((button) => {
            button.addEventListener("click", () => {
              coverageFilter = button.getAttribute("data-coverage-filter") || "all";
              renderSummary();
            });
          });

          target.querySelectorAll("[data-kpi-filter]").forEach((link) => {
            link.addEventListener("click", (event) => {
              event.preventDefault();
              coverageFilter = link.getAttribute("data-kpi-filter") || "all";
              const href = link.getAttribute("href") || "#critical-flow-coverage";
              renderSummary();
              document.querySelector(href)?.scrollIntoView({ behavior: "smooth", block: "start" });
            });
          });
        };

        renderSummary();
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
      .status-chip.not_covered { background: rgba(159,29,29,0.12); color: var(--danger); }
      .missing-preview { margin-top: 8px; font-size: 14px; color: var(--ink); }
      .missing-preview strong { color: var(--danger); }
      .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 20px; }
      .stack { display: grid; gap: 18px; }
      .intro h2, .detail-header h2 { margin: 0 0 8px; font-size: 28px; }
      .intro p, .detail-header p, .meta { color: var(--muted); margin: 0; line-height: 1.5; }
      .example-list { margin: 12px 0 0; padding-left: 18px; }
      .form-grid { display: grid; gap: 12px; }
      .field-label { display: block; margin-bottom: 8px; font-size: 15px; font-weight: 700; color: var(--ink); }
      textarea, input, button { font: inherit; }
      textarea, input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: #fff; }
      textarea { min-height: 96px; resize: vertical; }
      .button-row { display: flex; gap: 10px; flex-wrap: wrap; }
      button { border: none; border-radius: 999px; padding: 10px 16px; cursor: pointer; background: #efe6d7; }
      button.primary { background: var(--accent); color: white; }
      button.ghost-link { background: transparent; padding: 0; color: var(--accent); text-decoration: underline; }
      button:disabled { opacity: 0.6; cursor: wait; }
      .interpretation, .callout, .suggestions { border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
      .interpretation label + label { display: block; margin-top: 14px; }
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
      .detail-status { margin-top: 2px; }
      .detail-actions { margin-top: 10px; }
      .detail-section { padding-top: 18px; border-top: 1px solid rgba(216,207,191,0.75); }
      .detail-section h3 { margin: 0 0 10px; font-size: 20px; }
      .detail-section p { margin: 0; }
      .detail-support { margin-top: 8px; color: var(--muted); }
      ul { margin: 0; padding-left: 18px; }
      li { margin: 4px 0; overflow-wrap: anywhere; word-break: break-word; }
      .pills { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
      .pill { border: 1px solid var(--line); border-radius: 999px; background: #fff; padding: 8px 12px; cursor: pointer; }
      .empty-note { color: var(--muted); }
      @media (max-width: 900px) { main { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid var(--line); } }
    </style>
  </head>
  <body>
    <header>
      <h1><a href="/review/summary">What Did You Test?</a></h1>
      <p>Define expected behaviors and evaluate them against observed execution evidence.</p>
      <nav>
        <a href="/review">Observed Behaviors</a>
        <a class="active" href="${EXPECTED_BEHAVIORS_PATH}">Expected Behaviors</a>
        <a href="/review/summary">Summary</a>
      </nav>
    </header>
    <main>
      <aside>
        <div id="gapSummary"></div>
        <p class="rail-title">Saved Expected Behaviors</p>
        <div id="flows"></div>
      </aside>
      <section><div id="detail" class="panel">Loading…</div></section>
    </main>
    <script>
      let state = { flows: [], suggestions: [], hasDescriptors: false, selectedId: null, draftText: "", parsedDraft: null, isWorking: false, error: "", loadError: "", activeGapTerm: null, showDraftForm: false, editingFlowId: null, editingBaseline: null };
      const escapeHtml = (value) => String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
      const statusLabel = (status) => {
        if (status === "covered") {
          return "Covered";
        }
        if (status === "partial") {
          return "Partially Covered";
        }
        return "Not Covered";
      };
      const summarizeItems = (values) => Array.isArray(values) && values.length > 0
        ? values.map((value) => \`<li>\${escapeHtml(value.name || value)}</li>\`).join("")
        : "<li>-</li>";
      const normalizeCompareValue = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\\s+/g, " ").trim();
      const normalizeBehaviorLines = (value) => String(value || "")
        .split("\\n")
        .map((entry) => entry.trim())
        .filter(Boolean);
      const normalizeQualifierLines = (value) => String(value || "")
        .split("\\n")
        .map((entry) => entry.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, ""))
        .filter(Boolean);
      const serializeParsedFlow = (value) => JSON.stringify({
        name: value?.name || "",
        rawText: value?.rawText || "",
        interpretedSteps: Array.isArray(value?.interpretedSteps) ? value.interpretedSteps : [],
        interpretedTerms: Array.isArray(value?.interpretedTerms) ? value.interpretedTerms : [],
        outcome: value?.outcome || "",
        behavior: {
          action: value?.behavior?.action || "",
          qualifiers: Array.isArray(value?.behavior?.qualifiers) ? value.behavior.qualifiers : [],
        },
      });
      const hasEditedFlowChanges = () => {
        if (!state.editingFlowId || !state.parsedDraft || !state.editingBaseline) {
          return false;
        }

        return serializeParsedFlow(state.parsedDraft) !== serializeParsedFlow(state.editingBaseline);
      };
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
          const response = await fetch("${EXPECTED_BEHAVIORS_PATH}/interpret", {
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
      const redirectToLaunchpad = () => {
        window.location.assign("/review");
      };

      async function loadState() {
        try {
          const params = new URLSearchParams(window.location.search);
          const initialGapTerm = params.get("gapTerm");
          const initialFlowId = params.get("flowId");
          const [response, runtimeResponse] = await Promise.all([
            fetch("${EXPECTED_BEHAVIORS_PATH}/state"),
            fetch("/runtime/state"),
          ]);
          const nextState = await response.json();
          const runtimeState = await runtimeResponse.json();
          if (!runtimeState.hasData) {
            redirectToLaunchpad();
            return;
          }
          if (!response.ok) {
            throw new Error(nextState.error || "Unable to load expected behaviors.");
          }

          state.loadError = "";
          state.flows = nextState.flows;
          state.suggestions = nextState.suggestions;
          state.hasDescriptors = nextState.hasDescriptors;
          if (initialFlowId && nextState.flows.some((flow) => flow.id === initialFlowId)) {
            state.selectedId = initialFlowId;
          }
          if (initialGapTerm && nextState.flows.some((flow) => (flow.missingTerms || []).includes(initialGapTerm))) {
            state.activeGapTerm = initialGapTerm;
            state.selectedId = nextState.flows.find((flow) => (flow.missingTerms || []).includes(initialGapTerm))?.id ?? state.selectedId;
          }
          if (state.activeGapTerm && !getGapSummary().some((entry) => entry.term === state.activeGapTerm)) {
            state.activeGapTerm = null;
          }
          if (!state.selectedId && state.flows[0]) {
            state.selectedId = state.flows[0].id;
          }
          if (state.selectedId && !state.flows.some((flow) => flow.id === state.selectedId)) {
            state.selectedId = state.flows[0]?.id ?? null;
          }
        } catch (error) {
          state.loadError = error instanceof Error ? error.message : "Unable to load expected behaviors.";
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
          container.innerHTML = '<p class="empty-note">No expected behaviors saved yet.</p>';
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

      function renderDraftArea(options = {}) {
        const compact = options.compact === true;
        const parsed = state.parsedDraft;
        const interpretedBehavior = parsed
          ? [...new Set([...(parsed.interpretedSteps || []), ...(parsed.interpretedTerms || [])])].filter(Boolean)
          : [];
        const behaviorAction = parsed?.behavior?.action || "";
        const behaviorQualifiers = Array.isArray(parsed?.behavior?.qualifiers) ? parsed.behavior.qualifiers : [];
        const duplicateMatches = getLikelyDuplicates(parsed);
        const canSaveParsed = Boolean(parsed) && interpretedBehavior.length > 0;
        const disableSaveAction = state.editingFlowId
          ? !hasEditedFlowChanges() || !canSaveParsed || state.isWorking
          : !canSaveParsed || state.isWorking;
        const examples = state.suggestions.length === 0 ? \`
          <ul class="example-list">
            <li>Log in successfully</li>
            <li>Reset password</li>
            <li>Create and export a report</li>
            <li>Invite a new user</li>
          </ul>\` : "";
        const suggestions = !state.editingFlowId && state.hasDescriptors && state.suggestions.length > 0
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
              <p>Define expected behaviors and compare them against what was exercised during testing.</p>
              \${examples}
            </div>
            \${suggestions}
            <div class="form-grid">
              <label>
                <span class="field-label">Input</span>
                <textarea id="criticalFlowInput" placeholder="Log in and export a report to CSV">\${escapeHtml(state.draftText)}</textarea>
              </label>
              <p class="meta">Inputs are interpreted into comparable behavior terms for matching against observed execution.</p>
              <div class="button-row">
                <button class="primary" id="interpretFlow" \${state.isWorking ? "disabled" : ""}>Interpret</button>
                \${compact ? '<button type="button" id="cancelCriticalFlow">Cancel</button>' : ""}
              </div>
              \${state.error ? \`<p class="error">\${escapeHtml(state.error)}</p>\` : ""}
            </div>
            \${parsed ? \`
              <div class="interpretation">
                <label>
                  <span class="field-label">Display name</span>
                  <input id="criticalFlowNameInput" aria-label="Display name" value="\${escapeHtml(parsed.name || state.draftText)}" />
                </label>
                <label>
                  <span class="field-label">Interpreted behavior</span>
                  <textarea id="interpretedBehaviorInput" aria-label="Interpreted behavior">\${escapeHtml(interpretedBehavior.join("\\n"))}</textarea>
                </label>
                <label>
                  <span class="field-label">Action</span>
                  <input id="behaviorActionInput" aria-label="Action" value="\${escapeHtml(behaviorAction)}" />
                </label>
                <label>
                  <span class="field-label">Qualifiers</span>
                  <textarea id="behaviorQualifiersInput" aria-label="Qualifiers">\${escapeHtml(behaviorQualifiers.join("\\n"))}</textarea>
                </label>
                \${duplicateMatches.length > 0 ? \`
                  <div class="duplicate-warning">
                    <h3>Possible duplicate detected</h3>
                    <p class="meta">\${duplicateMatches.some((match) => match.exactDuplicate)
                      ? "This flow appears to already exist:"
                      : "This behavior appears similar to an existing expected behavior:"}</p>
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
                  <button class="primary" id="saveCriticalFlow" \${disableSaveAction ? "disabled" : ""}>\${state.editingFlowId ? "Save Changes" : "Save Expected Behavior"}</button>
                  \${duplicateMatches.length > 0 ? '<span class="meta">Save Anyway</span>' : ""}
                </div>
              </div>\`
            : ""}
            \${state.flows.length > 0 && !state.hasDescriptors ? \`
              <div class="callout">
                <p>We&apos;ll compare reviewed tests against these expected behaviors automatically.</p>
                <p>Next step: Capture and review a test run to start measuring coverage.</p>
                <div class="button-row"><a href="${GETTING_STARTED_PATH}"><button type="button">Learn how to capture a test</button></a></div>
              </div>\`
            : ""}
          </div>\`;
      }

      function renderSelectedFlow(flow) {
        const interpretedBehavior = [...new Set([...(flow.interpretedSteps || []), ...(flow.interpretedTerms || [])])]
          .filter(Boolean);
        const behaviorAction = flow.behavior?.action || "";
        const behaviorQualifiers = Array.isArray(flow.behavior?.qualifiers) ? flow.behavior.qualifiers : [];
        const statusText = flow.status === "covered"
          ? "✅ Covered"
          : flow.status === "partial"
            ? "⚠️ Partially Covered"
            : "❌ Not Covered";
        const explanationSection = flow.status === "not_covered"
          ? \`
            <div class="detail-section">
              <h3>Why it’s missing</h3>
              <p>No test evidence was found for this behavior.</p>
              <p class="detail-support">This may indicate missing test coverage or a mismatch in behavior naming.</p>
            </div>\`
          : flow.status === "partial"
            ? \`
            <div class="detail-section">
              <h3>Why it’s partially covered</h3>
              \${flow.matchedAction ? \`<p>Matched action: <strong>\${escapeHtml(flow.matchedAction)}</strong></p>\` : ""}
              \${flow.missingQualifiers.length > 0
                ? \`<p>Missing qualifiers:</p><ul>\${summarizeItems(flow.missingQualifiers.map((term) => term.replaceAll("_", " ")))}</ul>\`
                : '<p>Some parts of this behavior were not found in observed test execution.</p>'}
              <p class="detail-support">The general behavior was observed, but the distinguishing qualifier details were not found.</p>
            </div>\`
            : "";
        return \`
          <div class="stack">
            <div class="detail-header">
              <h2>\${escapeHtml(flow.name)}</h2>
              <p class="detail-status">Status: <span class="status-chip \${escapeHtml(flow.status)}">\${escapeHtml(statusText)}</span></p>
              <div class="button-row detail-actions">
                <button type="button" id="editCriticalFlow">Edit</button>
                <button type="button" id="deleteCriticalFlow">Delete</button>
              </div>
            </div>
            <div class="detail-section">
              <h3>Interpreted Behavior</h3>
              <ul>\${summarizeItems(interpretedBehavior)}</ul>
            </div>
            \${behaviorAction || behaviorQualifiers.length > 0 ? \`
            <div class="detail-section">
              <h3>Structured Behavior</h3>
              \${behaviorAction ? \`<p>Action: <strong>\${escapeHtml(behaviorAction)}</strong></p>\` : ""}
              \${behaviorQualifiers.length > 0
                ? \`<p>Qualifiers:</p><ul>\${summarizeItems(behaviorQualifiers.map((term) => term.replaceAll("_", " ")))}</ul>\`
                : ""}
            </div>\` : ""}
            \${explanationSection}
          </div>\`;
      }

      function renderDetail() {
        const detail = document.getElementById("detail");
        if (state.loadError) {
          detail.innerHTML = \`<p class="error">\${escapeHtml(state.loadError)}</p>\`;
          return;
        }

        const selectedFlow = state.flows.find((flow) => flow.id === state.selectedId);
        const hasFlows = state.flows.length > 0;
        detail.innerHTML =
          (hasFlows
            ? \`<div class="add-flow-bar"><button type="button" class="add-flow-button" id="openCriticalFlowForm">+ Add Expected Behavior</button></div>\`
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
            state.editingBaseline = null;
            state.parsedDraft = null;
            state.error = "";
            state.isWorking = false;
            render();
          });
        });

        detail.querySelector("#openCriticalFlowForm")?.addEventListener("click", () => {
          state.showDraftForm = true;
          state.editingFlowId = null;
          state.editingBaseline = null;
          state.draftText = "";
          state.parsedDraft = null;
          state.error = "";
          render();
        });

        detail.querySelector("#cancelCriticalFlow")?.addEventListener("click", () => {
          state.showDraftForm = false;
          state.editingFlowId = null;
          state.editingBaseline = null;
          state.parsedDraft = null;
          state.error = "";
          state.isWorking = false;
          render();
        });

        detail.querySelector("#closeCriticalFlowModal")?.addEventListener("click", () => {
          state.showDraftForm = false;
          state.editingFlowId = null;
          state.editingBaseline = null;
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
          state.editingBaseline = null;
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
          state.editingBaseline = null;
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
            behavior: selectedFlow.behavior,
          };
          state.editingBaseline = {
            name: selectedFlow.name,
            rawText: selectedFlow.rawText,
            interpretedSteps: selectedFlow.interpretedSteps,
            interpretedTerms: selectedFlow.interpretedTerms,
            outcome: selectedFlow.outcome,
            behavior: selectedFlow.behavior,
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

          const response = await fetch(\`${EXPECTED_BEHAVIORS_PATH}/\${encodeURIComponent(selectedFlow.id)}\`, { method: "DELETE" });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            state.error = payload.error || "Unable to delete critical flow.";
            render();
            return;
          }

          state.showDraftForm = false;
          state.editingFlowId = null;
          state.editingBaseline = null;
          state.parsedDraft = null;
          state.error = "";
          state.selectedId = state.flows.find((flow) => flow.id !== selectedFlow.id)?.id ?? null;
          await loadState();
        });

        detail.querySelector("#interpretFlow")?.addEventListener("click", async () => {
          const input = document.getElementById("criticalFlowInput");
          await interpretDraft(input.value);
        });

        detail.querySelector("#criticalFlowNameInput")?.addEventListener("input", (event) => {
          if (!state.parsedDraft) {
            return;
          }

          state.parsedDraft = {
            ...state.parsedDraft,
            name: event.target.value,
          };
          syncSaveButtonState();
        });

        detail.querySelector("#interpretedBehaviorInput")?.addEventListener("input", (event) => {
          if (!state.parsedDraft) {
            return;
          }

          const nextValues = normalizeBehaviorLines(event.target.value);
          state.parsedDraft = {
            ...state.parsedDraft,
            interpretedSteps: nextValues,
            interpretedTerms: nextValues,
          };
          syncSaveButtonState();
        });

        detail.querySelector("#behaviorActionInput")?.addEventListener("input", (event) => {
          if (!state.parsedDraft) {
            return;
          }

          const nextAction = String(event.target.value || "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .replace(/\\s+/g, " ")
            .trim();
          state.parsedDraft = {
            ...state.parsedDraft,
            behavior: {
              action: nextAction,
              qualifiers: Array.isArray(state.parsedDraft.behavior?.qualifiers) ? state.parsedDraft.behavior.qualifiers : [],
            },
          };
          syncSaveButtonState();
        });

        detail.querySelector("#behaviorQualifiersInput")?.addEventListener("input", (event) => {
          if (!state.parsedDraft) {
            return;
          }

          state.parsedDraft = {
            ...state.parsedDraft,
            behavior: {
              action: state.parsedDraft.behavior?.action || "",
              qualifiers: normalizeQualifierLines(event.target.value),
            },
          };
          syncSaveButtonState();
        });

        detail.querySelector("#saveCriticalFlow")?.addEventListener("click", async () => {
          const draftToSave = readDraftFromForm();
          if (!draftToSave) {
            return;
          }

          state.parsedDraft = draftToSave;
          state.isWorking = true;
          state.error = "";
          render();

          try {
            const response = await fetch(
              state.editingFlowId ? \`${EXPECTED_BEHAVIORS_PATH}/\${encodeURIComponent(state.editingFlowId)}\` : "${EXPECTED_BEHAVIORS_PATH}",
              {
              method: state.editingFlowId ? "PUT" : "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(draftToSave),
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
            state.editingBaseline = null;
            state.selectedId = payload.id;
            await loadState();
          } catch (error) {
            state.error = error instanceof Error ? error.message : "Unable to save critical flow.";
            state.isWorking = false;
            render();
          }
        });

        function syncSaveButtonState() {
          const saveButton = detail.querySelector("#saveCriticalFlow");
          if (!saveButton) {
            return;
          }

          const parsed = state.parsedDraft;
          const interpretedBehavior = parsed
            ? [...new Set([...(parsed.interpretedSteps || []), ...(parsed.interpretedTerms || [])])].filter(Boolean)
            : [];
          const canSaveParsed = Boolean(parsed) && interpretedBehavior.length > 0;
          const disabled = state.editingFlowId
            ? !hasEditedFlowChanges() || !canSaveParsed || state.isWorking
            : !canSaveParsed || state.isWorking;
          saveButton.disabled = disabled;
        }

        function readDraftFromForm() {
          if (!state.parsedDraft) {
            return null;
          }

          const nameInput = detail.querySelector("#criticalFlowNameInput");
          const interpretedBehaviorInput = detail.querySelector("#interpretedBehaviorInput");
          const behaviorActionInput = detail.querySelector("#behaviorActionInput");
          const behaviorQualifiersInput = detail.querySelector("#behaviorQualifiersInput");

          const nextValues = normalizeBehaviorLines(interpretedBehaviorInput?.value ?? "");
          return {
            ...state.parsedDraft,
            name: nameInput?.value ?? state.parsedDraft.name,
            interpretedSteps: nextValues,
            interpretedTerms: nextValues,
            behavior: {
              action: String(behaviorActionInput?.value || "")
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, " ")
                .replace(/\\s+/g, " ")
                .trim(),
              qualifiers: normalizeQualifierLines(behaviorQualifiersInput?.value ?? ""),
            },
          };
        }
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
      <p>This page is a placeholder for the getting started guide.</p>
      <p>TODO: Add product-specific guidance for capturing and reviewing the first test run.</p>
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
  const requestUrl = req.url ? new URL(req.url, getServerUrl(req)) : null;
  const requestPath = requestUrl?.pathname ?? null;

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && requestPath === "/ingest") {
    try {
      const body = await readJsonBody(req);

      if (!validateIngestPayload(body)) {
        writeJson(res, 400, { error: "Invalid ingest payload" });
        return;
      }

      const processed = await persistRun({
        suite: body.suite,
        run: body.run,
        environment: body.environment,
        endState: body.endState,
        events: body.events,
      });
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
    const bootstrapUrl = requestUrl ?? new URL("/bootstrap", getServerUrl(req));
    const serverUrl = requestUrl?.searchParams.get("serverUrl") ?? getServerUrl(req);
    const action = requestUrl?.searchParams.get("action");
    const tool = requestUrl?.searchParams.get("tool");
    const reason = requestUrl?.searchParams.get("reason");
    const browser = inferBrowserInfo(req);

    if (action !== "start" && action !== "finalize") {
      writeJson(res, 400, { error: "bootstrap action must be 'start' or 'finalize'" });
      return;
    }

    const environment = {
      ...(tool ? { tool } : {}),
      ...(browser ? { browser } : {}),
    };

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      renderBootstrapPage({
        action,
        serverUrl,
        suiteName: bootstrapUrl.searchParams.get("suiteName") ?? undefined,
        testName: bootstrapUrl.searchParams.get("testName") ?? undefined,
        environment: Object.keys(environment).length > 0 ? environment : undefined,
        reason: reason === "timeout" ? "timeout" : "completed",
      })
    );
    return;
  }

  if (req.method === "GET" && requestPath === "/") {
    res.writeHead(302, { location: "/review" });
    res.end();
    return;
  }

  if (req.method === "GET" && requestPath === "/review") {
    if (!(await hasAnyRuntimeData())) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderEmptyStatePage());
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderReviewPage());
    return;
  }

  if (req.method === "GET" && requestPath === "/review/summary") {
    if (!(await hasAnyRuntimeData())) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderEmptyStatePage());
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderReviewSummaryPage());
    return;
  }

  if (req.method === "GET" && requestPath === "/artifacts/export") {
    try {
      if (!(await hasAnyRuntimeData())) {
        writeJson(res, 400, { error: "No data available to export" });
        return;
      }

      const formatParam = requestUrl?.searchParams.get("format");
      const format = formatParam === "zip" ? "zip" : formatParam === "pdf" ? "pdf" : null;
      if (!format) {
        writeJson(res, 400, { error: "Export format must be 'pdf' or 'zip'" });
        return;
      }

      const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-export-"));
      const outputPath = path.join(tempDir, DEFAULT_EXPORT_FILE_NAMES[format]);
      try {
        const generatedPath = await exportArtifact({
          format,
          outputPath,
          pdfMode: process.env.WDYT_PDF_STUB === "1" ? "stub" : "puppeteer",
        });
        const fileBuffer = await readFile(generatedPath);
        const contentType = format === "pdf" ? "application/pdf" : "application/zip";
        const fileName = DEFAULT_EXPORT_FILE_NAMES[format];
        res.writeHead(200, {
          "content-type": contentType,
          "content-disposition": `attachment; filename="${fileName}"`,
        });
        res.end(fileBuffer);
        return;
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      writeJson(res, 500, { error: message });
      return;
    }
  }

  if (req.method === "GET" && requestPath === EXPECTED_BEHAVIORS_PATH) {
    if (!(await hasAnyRuntimeData())) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderEmptyStatePage());
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderCriticalFlowsPage());
    return;
  }

  if (req.method === "GET" && requestPath === GETTING_STARTED_PATH) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderCaptureGuidePage());
    return;
  }

  if (req.method === "GET" && requestPath === "/review/units") {
    writeJson(res, 200, await loadReviewUnitViews());
    return;
  }

  if (req.method === "GET" && requestPath === `${EXPECTED_BEHAVIORS_PATH}/state`) {
    writeJson(res, 200, await loadCriticalFlowState());
    return;
  }

  if (req.method === "GET" && requestPath === "/review/vocabulary") {
    writeJson(res, 200, await readJsonFile(getVocabularyPath(), []));
    return;
  }

  if (req.method === "GET" && requestPath === "/runtime/state") {
    writeJson(res, 200, { hasData: await hasAnyRuntimeData() });
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

  if (req.method === "POST" && requestPath === "/review/rebuild") {
    try {
      await refreshReviewUnits();
      writeJson(res, 200, { ok: true });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to rebuild review units.";
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

  if (req.method === "POST" && requestPath === `${EXPECTED_BEHAVIORS_PATH}/interpret`) {
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

  if (req.method === "POST" && requestPath === "/artifacts/import") {
    try {
      const body = (await readJsonBody(req)) as { files?: Array<{ name?: string; contentBase64?: string }> } | null;
      const files = Array.isArray(body?.files) ? body.files : [];
      if (files.length === 0) {
        writeJson(res, 400, { error: "At least one artifact (.zip) file is required." });
        return;
      }

      const buffers = files.map((file) => {
        if (typeof file.contentBase64 !== "string" || file.contentBase64.length === 0) {
          throw new Error("Each artifact must include base64 content.");
        }
        return Buffer.from(file.contentBase64, "base64");
      });

      await importArtifactBuffers(buffers);
      await refreshReviewUnits();

      writeJson(res, 200, { ok: true });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      writeJson(res, 500, { error: message });
      return;
    }
  }

  if (req.method === "POST" && requestPath === EXPECTED_BEHAVIORS_PATH) {
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

  if (req.method === "PUT" && requestPath?.startsWith(`${EXPECTED_BEHAVIORS_PATH}/`)) {
    try {
      const criticalFlowId = decodeURIComponent(requestPath.slice(`${EXPECTED_BEHAVIORS_PATH}/`.length));
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

  if (req.method === "DELETE" && requestPath?.startsWith(`${EXPECTED_BEHAVIORS_PATH}/`)) {
    try {
      const criticalFlowId = decodeURIComponent(requestPath.slice(`${EXPECTED_BEHAVIORS_PATH}/`.length));
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

server.listen(PORT, HOST, () => {
  console.log(`WDYT server listening on http://${HOST}:${PORT}`);
});
