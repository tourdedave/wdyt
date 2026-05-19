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
import { startMemoryLogging } from "./memory.js";
import {
  getReviewUnitViewCount,
  loadReviewUnits,
  loadReviewUnitView,
  loadReviewUnitViews,
  queueProposalProcessing,
  queryReviewUnitViews,
  refreshReviewUnits,
  requestReviewUnitReprocess,
  saveReviewUnitEdits,
  upsertVocabulary,
} from "./review.js";
import { persistRun } from "./storage.js";

const HOST = process.env.WDYT_HOST ?? "127.0.0.1";
const PORT = Number(process.env.WDYT_PORT ?? "3876");
const EXPECTED_BEHAVIORS_PATH = "/expected-behaviors";
const GETTING_STARTED_PATH = "/getting-started";
const REVIEW_PAGINATION_THRESHOLD = Number.parseInt(process.env.WDYT_REVIEW_PAGINATION_THRESHOLD ?? "50", 10) || 50;
const REVIEW_PAGE_SIZE = Number.parseInt(process.env.WDYT_REVIEW_PAGE_SIZE ?? "10", 10) || 10;

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

function renderFontFaceStyles() {
  return `
      @font-face {
        font-family: "Inter";
        src: url("/fonts/inter-var.woff2") format("woff2");
        font-style: normal;
        font-weight: 100 900;
        font-display: swap;
      }
      @font-face {
        font-family: "Newsreader";
        src: url("/fonts/newsreader-var.woff2") format("woff2");
        font-style: normal;
        font-weight: 200 800;
        font-display: swap;
      }
  `;
}

function renderAppShellStyles() {
  return `
      ${renderFontFaceStyles()}
      :root {
        color-scheme: light;
        --bg: #f8fafc;
        --bg-soft: #f1f5f9;
        --panel: #ffffff;
        --line: #e2e8f0;
        --line-strong: #cbd5e1;
        --ink: #0f172a;
        --muted: #64748b;
        --muted-2: #94a3b8;
        --accent: #166534;
        --accent-soft: #f0fdf4;
        --accent-border: #bbf7d0;
        --accent-ink: #15803d;
        --danger: #b91c1c;
        --warn: #a16207;
        --info: #1d4ed8;
        --font-sans: "Inter", "Segoe UI", system-ui, sans-serif;
        --font-serif: "Newsreader", "Iowan Old Style", "Palatino Linotype", serif;
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: var(--font-sans); color: var(--ink); background: var(--bg); }
      header { padding: 20px 24px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,0.92); backdrop-filter: blur(10px); position: relative; z-index: 30; isolation: isolate; }
      .header-shell { position: relative; z-index: 1; }
      .header-bar { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
      .header-copy { min-width: 0; }
      header h1 { margin: 0; font-family: var(--font-serif); font-size: 32px; font-weight: 600; letter-spacing: -0.01em; }
      header h1 a { color: inherit; text-decoration: none; }
      header h1 a:hover { text-decoration: underline; }
      header p { margin: 6px 0 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
      nav { margin-top: 10px; display: flex; gap: 12px; flex-wrap: wrap; }
      nav a { color: var(--accent); text-decoration: none; font-family: var(--font-sans); font-size: 15px; font-weight: 600; }
      nav a.active { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
      .page-utility { position: absolute; top: 50%; right: 0; transform: translateY(-50%); z-index: 31; }
      .page-utility.open { z-index: 40; }
      .page-utility-trigger {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 7px 10px;
        background: transparent;
        color: var(--muted);
        text-decoration: none;
        font-size: 13px;
        font-weight: 600;
        white-space: nowrap;
        cursor: pointer;
      }
      .page-utility-trigger:hover { border-color: var(--line-strong); background: #fff; color: var(--ink); }
      .page-utility-trigger:focus,
      .page-utility-trigger:focus-visible { outline: none; }
      .page-utility-panel {
        position: absolute;
        top: calc(100% + 10px);
        right: 0;
        z-index: 41;
        min-width: 220px;
        padding: 8px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: rgba(255,255,255,0.98);
        box-shadow: 0 14px 28px rgba(15,23,42,0.08);
      }
      .page-utility-panel[hidden] { display: none; }
      .page-utility-option {
        display: block;
        width: 100%;
        padding: 10px 12px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: var(--ink);
        text-decoration: none;
        text-align: left;
        font-size: 14px;
        line-height: 1.35;
        cursor: pointer;
      }
      .page-utility-option:hover { background: #f8fafc; }
      .page-utility-option:focus,
      .page-utility-option:focus-visible { outline: none; box-shadow: none; }
  `;
}

function renderAppHeader(options: {
  subtitle: string;
  active: "review" | "expected" | "summary";
  utilityMarkup?: string;
}) {
  const utilityMarkup = options.utilityMarkup ?? "";
  return `
    <header>
      <div class="header-shell">
        <div class="header-bar">
          <div class="header-copy">
            <h1><a href="/review/summary">What Did You Test?</a></h1>
            <p>${options.subtitle}</p>
            <nav>
              <a ${options.active === "review" ? 'class="active"' : ""} href="/review">Observed Behaviors</a>
              <a ${options.active === "expected" ? 'class="active"' : ""} href="${EXPECTED_BEHAVIORS_PATH}">Expected Behaviors</a>
              <a ${options.active === "summary" ? 'class="active"' : ""} href="/review/summary">Summary</a>
            </nav>
          </div>
        </div>
        ${utilityMarkup}
      </div>
    </header>`;
}

function renderUtilityMenuScript() {
  return `
      document.querySelectorAll("[data-page-utility]").forEach((menu) => {
        const trigger = menu.querySelector("[data-page-utility-trigger]");
        const panel = menu.querySelector("[data-page-utility-panel]");
        if (!trigger || !panel) {
          return;
        }

        const closeMenu = () => {
          menu.classList.remove("open");
          panel.hidden = true;
          trigger.setAttribute("aria-expanded", "false");
        };

        const openMenu = () => {
          menu.classList.add("open");
          panel.hidden = false;
          trigger.setAttribute("aria-expanded", "true");
        };

        trigger.addEventListener("click", (event) => {
          event.preventDefault();
          if (panel.hidden) {
            openMenu();
            return;
          }
          closeMenu();
        });

        document.addEventListener("click", (event) => {
          if (!menu.contains(event.target)) {
            closeMenu();
          }
        });

        menu.querySelectorAll("[data-page-utility-close]").forEach((item) => {
          item.addEventListener("click", () => {
            closeMenu();
          });
        });

        menu.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            closeMenu();
          }
        });
      });
  `;
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
      ${renderAppShellStyles()}
      main { display: grid; grid-template-columns: 336px 1fr; min-height: calc(100vh - 89px); background: #fff; }
      aside {
        border-right: 1px solid var(--line);
        padding: 10px 0 16px;
        overflow: auto;
        background: #fff;
      }
      #units { display: grid; }
      .unit-card {
        border: 1px solid transparent;
        border-left: 2px solid transparent;
        border-right: 0;
        border-top: 0;
        border-bottom: 1px solid var(--line);
        background: transparent;
        border-radius: 0;
        padding: 10px 16px 10px 18px;
        cursor: pointer;
      }
      .unit-card:hover { background: #f8fafc; }
      .unit-card.active {
        background: linear-gradient(90deg, rgba(22,101,52,0.05), rgba(255,255,255,1));
        border-left-color: var(--accent);
      }
      .unit-card.related { border-left-color: var(--warn); }
      .unit-card.dimmed { opacity: 0.56; }
      .unit-card h2 { margin: 0; font-size: 14px; line-height: 1.28; font-weight: 600; }
      .unit-card-meta { margin-top: 5px; display: flex; flex-wrap: wrap; gap: 6px 8px; color: var(--muted); font-size: 11px; line-height: 1.3; }
      .unit-card-secondary { margin-top: 6px; color: var(--muted); font-size: 11px; line-height: 1.35; }
      .unit-card-summary { margin-top: 6px; color: var(--muted); font-size: 12px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .meta { color: var(--muted); font-size: 14px; line-height: 1.4; }
      .overlap-summary { display: grid; gap: 8px; margin: 0 16px 14px; padding: 0 0 14px; border-bottom: 1px solid var(--line); }
      .rail-title { margin: 0; color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: 0.01em; }
      .overlap-card {
        border: 1px solid var(--line);
        background: #fff;
        border-radius: 8px;
        padding: 9px 11px;
        cursor: pointer;
      }
      .overlap-card.active { border-color: #fcd34d; background: #fffdf5; }
      .overlap-term { display: inline-block; font-weight: 700; font-size: 14px; margin-bottom: 4px; }
      .list-controls { display: grid; gap: 10px; margin: 0 16px 14px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
      .list-controls label { display: grid; gap: 6px; color: var(--muted); font-size: 14px; }
      .list-controls input { width: 100%; }
      .filter-indicator {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 9px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: #fff;
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        line-height: 1.2;
      }
      .filter-indicator button {
        border: 0;
        background: transparent;
        color: inherit;
        padding: 0;
        min-width: auto;
        line-height: 1;
        cursor: pointer;
      }
      .filter-indicator button:hover:not(:disabled) {
        border: 0;
        background: transparent;
        color: var(--ink);
      }
      .pagination-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin: 14px 16px 0;
      }
      .page-summary { color: var(--muted); font-size: 13px; }
      section { padding: 18px 20px; overflow: auto; background: #fff; }
      .panel {
        background: var(--panel);
        border: 1px solid #e8edf5;
        border-radius: 12px;
        padding: 22px 24px;
        box-shadow: none;
      }
      .detail-header { display: grid; gap: 14px; }
      .detail-header-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; }
      .descriptor { font-family: var(--font-serif); font-size: 30px; font-weight: 600; line-height: 1.06; letter-spacing: -0.012em; margin: 0; }
      .detail-summary { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.55; max-width: 78ch; }
      .detail-badges { display: flex; flex-wrap: wrap; gap: 8px; }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 9px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: #fff;
        color: var(--muted);
        font-family: var(--font-sans);
        font-size: 11px;
        font-weight: 700;
        line-height: 1.2;
      }
      .badge.status-edited { color: #1d4ed8; border-color: #bfdbfe; background: #eff6ff; }
      .badge.status-error { color: var(--danger); border-color: #fecaca; background: #fef2f2; }
      .badge.status-processing, .badge.status-auto-generated, .badge.status-reprocessed, .badge.confidence-medium { color: var(--warn); border-color: #fde68a; background: #fffbeb; }
      .badge.confidence-low { color: var(--muted); border-color: var(--line); background: #f8fafc; }
      .meta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 16px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.5;
        padding: 6px 0 14px;
        border-bottom: 1px solid var(--line);
      }
      .meta-item strong { color: var(--ink); font-weight: 600; margin-right: 4px; }
      .section-stack { display: grid; gap: 20px; margin-top: 18px; }
      .doc-section { display: grid; gap: 8px; padding-top: 0; }
      .doc-section + .doc-section { padding-top: 16px; border-top: 1px solid var(--line); }
      .doc-section h3 { margin: 0; font-family: var(--font-serif); font-size: 20px; font-weight: 600; line-height: 1.15; color: var(--ink); }
      .section-body { display: grid; gap: 12px; }
      .section-copy { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
      .sequence { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; font-size: 13px; line-height: 1.5; }
      .sequence-step { padding: 2px 0; border-radius: 0; background: transparent; border: 0; color: var(--ink); }
      .sequence-arrow { color: var(--muted-2); font-size: 12px; }
      .flow-block { padding: 2px 0 0; }
      .evidence-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 28px; }
      .evidence-group { min-width: 0; }
      .evidence-group h4 { margin: 0 0 8px; font-family: var(--font-sans); font-size: 13px; font-weight: 600; letter-spacing: 0.01em; color: var(--ink); }
      .evidence-rows { display: grid; gap: 5px; }
      .evidence-row { display: grid; grid-template-columns: 84px 1fr; gap: 10px; padding-top: 5px; border-top: 1px solid var(--line); }
      .evidence-row:first-child { border-top: 0; padding-top: 0; }
      .evidence-key { color: var(--muted); font-size: 11px; letter-spacing: 0.01em; }
      .evidence-value { color: var(--ink); font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; word-break: break-word; }
      .evidence-empty { color: var(--muted); font-size: 13px; }
      .raw-steps details, .evidence-notes details {
        border: 1px solid var(--line);
        border-radius: 10px;
        background: #fcfdff;
        padding: 12px 14px;
      }
      details summary { cursor: pointer; color: var(--ink); font-family: var(--font-sans); font-size: 13px; font-weight: 600; }
      details[open] summary { margin-bottom: 10px; }
      ul { margin: 0; padding-left: 18px; }
      li { margin: 4px 0; overflow-wrap: anywhere; word-break: break-word; color: var(--ink); font-size: 13px; line-height: 1.45; }
      .actions { display: grid; gap: 12px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); }
      input, textarea, button { font: inherit; }
      textarea, input { width: 100%; padding: 9px 11px; border-radius: 10px; border: 1px solid var(--line); background: #fff; color: var(--ink); font-family: var(--font-sans); font-size: 13px; }
      .button-row { display: flex; gap: 10px; flex-wrap: wrap; }
      button { border: 1px solid var(--line); border-radius: 10px; padding: 9px 13px; cursor: pointer; background: #fff; color: var(--ink); font-family: var(--font-sans); font-size: 13px; font-weight: 600; }
      button:hover:not(:disabled) { border-color: var(--line-strong); background: #f8fafc; }
      button.primary { background: var(--accent); color: white; border-color: var(--accent); }
      button.primary:hover:not(:disabled) { background: #14532d; border-color: #14532d; }
      button.reject { background: var(--danger); color: white; }
      button:disabled { cursor: default; opacity: 0.6; }
      #empty { color: var(--muted); }
      .summary-link { color: var(--accent); text-decoration: none; font-family: var(--font-sans); font-weight: 600; }
      .decision-editor { display: none; }
      .decision-editor.open { display: grid; gap: 12px; padding-top: 16px; border-top: 1px solid var(--line); }
      .transition-banner { margin-bottom: 18px; padding: 10px 12px; border-radius: 10px; border: 1px solid #bbf7d0; background: var(--accent-soft); color: var(--accent); font-size: 14px; }
      .panel.is-submitting { opacity: 0.72; transition: opacity 120ms ease; }
      @media (max-width: 900px) {
        .page-utility { position: static; transform: none; margin-top: 12px; }
        main { grid-template-columns: 1fr; }
        aside { border-right: 0; border-bottom: 1px solid var(--line); }
        .evidence-grid { grid-template-columns: 1fr; }
        .detail-header-top { flex-direction: column; }
        .page-utility-panel { right: auto; left: 0; }
        section { padding: 16px; }
        .panel { padding: 18px 16px; }
      }
    </style>
  </head>
  <body>
    ${renderAppHeader({
      subtitle: "Review and refine observed behaviors before evaluating coverage.",
      active: "review",
      utilityMarkup: `<div class="page-utility" id="reviewSettingsMenu" data-page-utility>
          <button type="button" class="page-utility-trigger" id="reviewSettingsTrigger" data-page-utility-trigger aria-haspopup="menu" aria-expanded="false">Settings <span aria-hidden="true">▾</span></button>
          <div class="page-utility-panel" id="reviewSettingsPanel" data-page-utility-panel hidden>
            <button type="button" class="page-utility-option" id="rebuildReviewUnits" data-page-utility-close>Rebuild Observed Behaviors</button>
          </div>
        </div>`,
    })}
    <main>
      <aside><div id="listControls"></div><div id="overlapSummary"></div><div id="units"></div><div id="listPagination"></div></aside>
      <section><div id="detail" class="panel"><p id="empty">Select a flow variant to review.</p></div></section>
    </main>
    <script>
      let state = {
        mode: "full",
        units: [],
        allUnits: [],
        selectedUnit: null,
        vocabulary: [],
        selectedId: null,
        editingId: null,
        submittingReviewId: null,
        transitionMessage: "",
        pendingFocusHeading: false,
        activeOverlapKey: null,
        rebuilding: false,
        initialized: false,
        page: 1,
        pageSize: ${REVIEW_PAGE_SIZE},
        totalUnits: 0,
        totalPages: 1,
        query: "",
        structureKey: "",
        fromSummary: false,
      };
      const summarize = (value) => Array.isArray(value) && value.length > 0 ? value.join(", ") : "-";
      const truncate = (value, max = 110) => {
        const text = String(value || "").trim();
        if (!text) return "";
        return text.length > max ? text.slice(0, max - 1) + "…" : text;
      };
      const escapeHtml = (value) => String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
      const getActiveUnits = () => (state.mode === "scaled" ? state.units : state.allUnits).filter((unit) => unit.proposalState === "proposed" || unit.activeDescriptor);
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
        (state.mode === "scaled" ? [] : state.allUnits).filter(
          (unit) =>
            unit.proposalState === "proposed" && (unit.activeDescriptor || unit.proposedDescriptor)
        );
      const getStructureKey = (unit) => String(unit.structureKey || "").trim();
      const getStructureGroupTitle = (units) => {
        const descriptors = units
          .map((unit) => String(unit.activeDescriptor || unit.proposedDescriptor || unit.canonical.join(" → ")).trim())
          .filter(Boolean);
        if (descriptors.length === 0) {
          return units[0]?.canonical?.join(" → ") || "Observed behavior";
        }
        const counts = new Map();
        descriptors.forEach((descriptor) => {
          counts.set(descriptor, (counts.get(descriptor) || 0) + 1);
        });
        return [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0][0];
      };
      const getOverlapGroups = () => {
        const groups = new Map();
        getComparableUnits().forEach((unit) => {
          const structureKey = getStructureKey(unit);
          if (!structureKey) {
            return;
          }

          const current = groups.get(structureKey);
          if (current) {
            current.units.push(unit);
            return;
          }

          groups.set(structureKey, {
            key: structureKey,
            units: [unit],
          });
        });

        return [...groups.values()]
          .filter((group) => group.units.length > 1)
          .sort((a, b) => b.units.length - a.units.length || getStructureGroupTitle(a.units).localeCompare(getStructureGroupTitle(b.units)));
      };
      const getOverlapTitle = (group) => getStructureGroupTitle(group.units);
      const getDisplayStatus = (unit) => {
        if (unit.interpretationStatus === "edited") return "edited";
        if (unit.interpretationStatus === "reprocessed") return "reprocessed";
        if (unit.proposalState === "processing") return "generating proposal";
        if (unit.proposalState === "error") return "proposal failed";
        return null;
      };
      const getStatusTone = (status) => {
        if (status === "edited") return "status-edited";
        if (status === "proposal failed") return "status-error";
        if (status === "generating proposal") return "status-processing";
        if (status === "reprocessed") return "status-reprocessed";
        return "status-auto-generated";
      };
      const getConfidenceTone = (value) => {
        if (typeof value !== "number") return "confidence-low";
        if (value >= 0.6) return "confidence-medium";
        return "confidence-low";
      };
      const getConfidenceLabel = (value) => {
        if (typeof value !== "number") {
          return null;
        }
        if (value >= 0.8) {
          return "High confidence";
        }
        if (value >= 0.6) {
          return "Moderate confidence";
        }
        return "Low confidence";
      };
      const getCardStatus = (unit) => {
        if (unit.proposalState === "processing") return "generating proposal";
        if (unit.proposalState === "error") return "proposal failed";
        return null;
      };
      const getPrimaryTest = (unit) => Array.isArray(unit.tests) && unit.tests.length > 0 ? unit.tests[0] : null;
      const getPrimarySuite = (unit) => Array.isArray(unit.suites) && unit.suites.length > 0 ? unit.suites[0] : null;
      const getPrimaryTool = (unit) => Array.isArray(unit.tools) && unit.tools.length > 0 ? unit.tools[0] : null;
      const getPrimaryBrowser = (unit) => Array.isArray(unit.browsers) && unit.browsers.length > 0 ? unit.browsers[0] : null;
      const getPrimaryHeading = (unit) => (Array.isArray(unit.headings) && unit.headings[0]) || (Array.isArray(unit.titles) && unit.titles[0]) || null;
      const getPrimaryFinalUrl = (unit) => Array.isArray(unit.finalUrls) && unit.finalUrls.length > 0 ? unit.finalUrls[0] : null;
      const getUnitSummary = (unit) =>
        unit.proposedRationale ||
        (getPrimaryHeading(unit) ? \`Ended on \${getPrimaryHeading(unit)}.\` : "") ||
        (getPrimaryFinalUrl(unit) ? \`Ended at \${getPrimaryFinalUrl(unit)}.\` : "") ||
        "";
      const humanizeRawStep = (step) => {
        if (step === "NAVIGATE") return "Navigate";
        if (step === "INPUT") return "Input";
        if (step === "CHANGE") return "Change";
        if (step === "CLICK") return "Click";
        if (step === "SUBMIT") return "Submit";
        return String(step);
      };
      const humanizeCanonicalStep = (step, unit) => {
        if (step === "NAVIGATE") {
          const finalLabel = getPrimaryHeading(unit);
          return finalLabel ? \`Navigate to \${finalLabel}\` : "Navigate";
        }
        if (step === "INPUT" || step === "CHANGE") {
          const targets = Array.isArray(unit.targets) ? unit.targets.join(" ") : "";
          if (/credential|username|password|sign in/i.test(targets)) return "Input credentials";
          if (/search/i.test(targets)) return "Input search query";
          return "Input details";
        }
        if (step === "CLICK") {
          const targets = Array.isArray(unit.targets) ? unit.targets.join(" ") : "";
          if (/sign in/i.test(targets)) return "Choose sign in";
          if (/search/i.test(targets)) return "Choose search";
          return "Choose action";
        }
        if (step === "SUBMIT") return "Submit";
        return humanizeRawStep(step);
      };
      const buildFlowSequence = (unit) => {
        const steps = [];
        let inputAdded = false;
        let submitAdded = false;
        for (const step of unit.canonical || []) {
          if (step === "NAVIGATE") {
            if (steps.length === 0) {
              steps.push("Open flow");
            }
            continue;
          }
          if ((step === "INPUT" || step === "CHANGE") && !inputAdded) {
            steps.push(humanizeCanonicalStep(step, unit));
            inputAdded = true;
            continue;
          }
          if (step === "CLICK") {
            steps.push(humanizeCanonicalStep(step, unit));
            continue;
          }
          if (step === "SUBMIT" && !submitAdded) {
            steps.push("Submit");
            submitAdded = true;
          }
        }
        const finalLabel = (unit.headings && unit.headings[0]) || (unit.titles && unit.titles[0]) || null;
        if (finalLabel) {
          steps.push(\`\${finalLabel} loaded\`);
        }
        return steps.length > 0 ? steps : (unit.canonical || []).map(humanizeRawStep);
      };
      const redirectToLaunchpad = () => {
        window.location.assign("/review");
      };
      const getProtectedFocusTarget = () => {
        const activeId = document.activeElement?.id;
        if (state.editingId && ["approvedDescriptor", "promoteVocab", "reviewNotes"].includes(activeId)) {
          return "editor";
        }
        if (activeId === "reviewSearchInput") {
          return "search";
        }
        return null;
      };
      const getOpenDetailSections = () =>
        Array.from(document.querySelectorAll("#detail details[open][data-preserve-open]"))
          .map((node) => node.getAttribute("id"))
          .filter(Boolean);
      const restoreOpenDetailSections = (sectionIds) => {
        if (!Array.isArray(sectionIds) || sectionIds.length === 0) {
          return;
        }
        sectionIds.forEach((id) => {
          const node = document.getElementById(id);
          if (node && node.tagName === "DETAILS") {
            node.open = true;
          }
        });
      };
      const getCurrentUnit = () =>
        state.mode === "scaled"
          ? state.selectedUnit
          : getVisibleUnits().find((candidate) => candidate.reviewId === state.selectedId);
      const normalizeReviewQuery = (value) => String(value || "").trim().toLowerCase();
      const getConfidenceBucket = (value) => {
        if (typeof value !== "number") {
          return "low";
        }
        if (value >= 0.8) {
          return "high";
        }
        if (value >= 0.6) {
          return "moderate";
        }
        return "low";
      };
      const matchesReviewQuery = (unit, rawQuery) => {
        const normalizedQuery = normalizeReviewQuery(rawQuery);
        if (!normalizedQuery) {
          return true;
        }

        const confidenceFilters = new Set();
        const textQuery = normalizedQuery
          .replace(/\bconfidence:(low|moderate|high)\b/g, (_match, bucket) => {
            confidenceFilters.add(bucket);
            return " ";
          })
          .replace(/\b(low|moderate|high)\s+confidence\b/g, (_match, bucket) => {
            confidenceFilters.add(bucket);
            return " ";
          })
          .replace(/\s+/g, " ")
          .trim();

        if (confidenceFilters.size > 0) {
          if (!confidenceFilters.has(getConfidenceBucket(unit.proposedConfidence))) {
            return false;
          }
        }

        if (!textQuery) {
          return true;
        }

        const haystacks = [
          unit.reviewId,
          unit.flowId,
          unit.activeDescriptor,
          unit.proposedDescriptor,
          ...(unit.tests || []),
          ...(unit.suites || []),
          ...(unit.tools || []),
          ...(unit.browsers || []),
          ...(unit.primaryTerms || []),
          ...(unit.prerequisites || []),
          ...(unit.outcomeTerms || []),
          ...(unit.activeVocab || []),
          ...(unit.finalUrls || []),
          ...(unit.headings || []),
        ];

        return haystacks.some((value) => String(value || "").toLowerCase().includes(textQuery));
      };
      const matchesStructureKey = (unit, structureKey) => {
        const normalizedKey = String(structureKey || "").trim();
        if (!normalizedKey) {
          return true;
        }
        return String(unit.structureKey || "") === normalizedKey;
      };
      const getVisibleUnits = () => {
        if (state.mode === "scaled") {
          return state.units;
        }
        return state.allUnits.filter((unit) => matchesStructureKey(unit, state.structureKey) && matchesReviewQuery(unit, state.query));
      };
      const syncReviewUrl = () => {
        const params = new URLSearchParams();
        if (state.structureKey) {
          params.set("structureKey", state.structureKey);
        }
        if (state.query) {
          params.set("q", state.query);
        } else if (!state.structureKey) {
          if (state.selectedId) {
            params.set("reviewId", state.selectedId);
          }
          if (state.activeOverlapKey) {
            params.set("overlapKey", state.activeOverlapKey);
          }
        }
        if (state.fromSummary && (state.query || state.structureKey)) {
          params.set("from", "summary");
        }
        const next = params.toString() ? \`/review?\${params.toString()}\` : "/review";
        window.history.replaceState(null, "", next);
      };

      async function fetchReviewUnit(reviewId) {
        const response = await fetch(\`/review/units/\${encodeURIComponent(reviewId)}\`);
        if (!response.ok) {
          return null;
        }

        return response.json();
      }

      async function loadState() {
        const protectedFocusTarget = getProtectedFocusTarget();
        const params = new URLSearchParams(window.location.search);
        const initialReviewId = state.initialized ? null : params.get("reviewId");
        const initialOverlapKey = state.initialized ? null : params.get("overlapKey");
        const initialQuery = state.initialized ? state.query : (params.get("q") ?? "").trim();
        const initialStructureKey = state.initialized ? state.structureKey : (params.get("structureKey") ?? "").trim();
        const fromSummary = state.initialized ? state.fromSummary : params.get("from") === "summary";
        const [vocabRes, runtimeRes, metaRes] = await Promise.all([
          fetch("/review/vocabulary"),
          fetch("/runtime/state"),
          fetch("/review/units/meta"),
        ]);
        state.vocabulary = await vocabRes.json();
        const runtimeState = await runtimeRes.json();
        if (!runtimeState.hasData) {
          redirectToLaunchpad();
          return;
        }

        const meta = await metaRes.json();
        state.mode = meta.mode;
        state.pageSize = meta.pageSize;
        state.totalUnits = meta.total;
        state.query = initialQuery;
        state.structureKey = initialStructureKey;
        state.fromSummary = fromSummary && (initialQuery.length > 0 || initialStructureKey.length > 0);

        if (state.mode === "full") {
          const unitsRes = await fetch("/review/units");
          const nextUnits = await unitsRes.json();
          state.units = nextUnits;
          state.allUnits = nextUnits;
          state.selectedUnit = null;

          const visibleUnits = getVisibleUnits();
          const activeUnits = visibleUnits.filter((unit) => unit.proposalState === "proposed" || unit.activeDescriptor);
          const overlapGroups = state.query ? [] : getOverlapGroups();
          if (!state.query && initialOverlapKey && overlapGroups.some((group) => group.key === initialOverlapKey)) {
            state.activeOverlapKey = initialOverlapKey;
            if (!initialReviewId) {
              state.selectedId = overlapGroups.find((group) => group.key === initialOverlapKey)?.units[0]?.reviewId ?? state.selectedId;
            }
          } else if (state.query) {
            state.activeOverlapKey = null;
          }
          if (!state.query && !state.selectedId && initialReviewId && visibleUnits.some((unit) => unit.reviewId === initialReviewId)) {
            state.selectedId = initialReviewId;
          }
          if (!state.selectedId && activeUnits[0]) state.selectedId = activeUnits[0].reviewId;
          if (state.selectedId && !visibleUnits.some((unit) => unit.reviewId === state.selectedId)) {
            state.selectedId = activeUnits[0]?.reviewId ?? visibleUnits[0]?.reviewId ?? null;
          }
        } else {
          const queryRes = await fetch(\`/review/units/query?page=\${encodeURIComponent(String(state.page))}&pageSize=\${encodeURIComponent(String(state.pageSize))}&q=\${encodeURIComponent(state.query)}&structureKey=\${encodeURIComponent(state.structureKey)}\`);
          const paged = await queryRes.json();
          state.units = paged.units;
          state.allUnits = [];
          state.page = paged.page;
          state.totalPages = paged.totalPages;
          state.totalUnits = paged.total;
          state.activeOverlapKey = null;

          if (!state.selectedId && initialReviewId) {
            state.selectedId = initialReviewId;
          }
          if (!state.selectedId) {
            state.selectedId = state.units[0]?.reviewId ?? null;
          }
          if (state.selectedId) {
            const pageUnit = state.units.find((unit) => unit.reviewId === state.selectedId);
            state.selectedUnit = pageUnit ?? await fetchReviewUnit(state.selectedId);
            if (!state.selectedUnit && state.units[0]) {
              state.selectedId = state.units[0].reviewId;
              state.selectedUnit = state.units[0];
            }
          } else {
            state.selectedUnit = null;
          }
        }

        state.initialized = true;
        syncReviewUrl();
        render({
          preserveDetail: protectedFocusTarget === "editor",
          preserveListControls: protectedFocusTarget === "search",
        });
      }

      function renderListControls() {
        const container = document.getElementById("listControls");
        container.innerHTML = \`
          <div class="list-controls">
            <label>
              <span>Search observed behaviors</span>
              <input id="reviewSearchInput" type="search" value="\${escapeHtml(state.query)}" placeholder="Search behaviors, tests, terms, or confidence:low" />
            </label>
            \${state.fromSummary && (state.query || state.structureKey) ? '<div class="filter-indicator">Filtered from Summary <button type="button" id="clearSummaryFilter" aria-label="Clear summary filter">×</button></div>' : ""}
          </div>\`;

        const input = document.getElementById("reviewSearchInput");
        input?.addEventListener("keydown", async (event) => {
          if (event.key !== "Enter") {
            return;
          }
          state.query = input.value.trim();
          state.fromSummary = false;
          state.structureKey = "";
          state.page = 1;
          state.selectedId = null;
          await loadState();
        });
        input?.addEventListener("search", async () => {
          state.query = input.value.trim();
          state.fromSummary = false;
          state.structureKey = "";
          state.page = 1;
          state.selectedId = null;
          await loadState();
        });
        input?.addEventListener("blur", async () => {
          const nextQuery = input.value.trim();
          if (nextQuery === state.query) {
            return;
          }
          state.query = nextQuery;
          state.fromSummary = false;
          state.structureKey = "";
          state.page = 1;
          state.selectedId = null;
          await loadState();
        });
        document.getElementById("clearSummaryFilter")?.addEventListener("click", async () => {
          state.query = "";
          state.structureKey = "";
          state.fromSummary = false;
          state.page = 1;
          state.selectedId = null;
          await loadState();
        });
      }

      function renderOverlapSummary() {
        const container = document.getElementById("overlapSummary");
        if (state.mode === "scaled" || state.query) {
          container.innerHTML = "";
          return;
        }
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
                <div class="meta">\${escapeHtml(group.units.length === 1 ? "Observed in 1 execution:" : \`Observed in \${group.units.length} executions:\`)}</div>
                <div class="meta">
                  \${group.units.map((unit) => \`<div>- \${escapeHtml(getPrimaryTest(unit) || unit.activeDescriptor || unit.proposedDescriptor || unit.canonical.join(" → "))}</div>\`).join("")}
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
        const visibleUnits = getVisibleUnits();
        if (visibleUnits.length === 0) {
          container.innerHTML = "";
          return;
        }
        container.innerHTML = visibleUnits.map((unit) => \`
          <article class="unit-card \${unit.reviewId === state.selectedId ? "active" : ""} \${state.activeOverlapKey && getOverlapGroups().find((group) => group.key === state.activeOverlapKey)?.units.some((candidate) => candidate.reviewId === unit.reviewId) ? "related" : ""} \${state.activeOverlapKey && !getOverlapGroups().find((group) => group.key === state.activeOverlapKey)?.units.some((candidate) => candidate.reviewId === unit.reviewId) ? "dimmed" : ""}" data-id="\${escapeHtml(unit.reviewId)}">
            <h2>\${escapeHtml(unit.activeDescriptor || unit.proposedDescriptor || unit.canonical.join(" → "))}</h2>
            <div class="unit-card-meta">
              \${getDisplayStatus(unit) ? \`<span class="badge \${getStatusTone(getDisplayStatus(unit))}">\${escapeHtml(getDisplayStatus(unit))}</span>\` : ""}
              \${getConfidenceLabel(unit.proposedConfidence) ? \`<span class="badge \${getConfidenceTone(unit.proposedConfidence)}">\${escapeHtml(getConfidenceLabel(unit.proposedConfidence))}</span>\` : ""}
            </div>
            <div class="unit-card-secondary">
              \${[
                getPrimaryTest(unit),
                getPrimarySuite(unit),
                getPrimaryTool(unit),
                getPrimaryBrowser(unit),
              ].filter(Boolean).map((value) => escapeHtml(value)).join(" · ") || escapeHtml(summarize(unit.finalUrls))}
            </div>
            \${getUnitSummary(unit) ? \`<div class="unit-card-summary">\${escapeHtml(truncate(getUnitSummary(unit), 120))}</div>\` : ""}
          </article>\`).join("");
        container.querySelectorAll(".unit-card").forEach((node) => {
          node.addEventListener("click", async () => {
            state.selectedId = node.getAttribute("data-id");
            if (state.mode === "scaled") {
              state.selectedUnit = await fetchReviewUnit(state.selectedId);
            }
            render();
          });
        });
      }

      function renderPagination() {
        const container = document.getElementById("listPagination");
        if (state.mode !== "scaled" || state.totalPages <= 1) {
          container.innerHTML = "";
          return;
        }

        const firstIndex = state.totalUnits === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
        const lastIndex = Math.min(state.totalUnits, state.page * state.pageSize);
        container.innerHTML = \`
          <div class="pagination-bar">
            <div class="page-summary">Showing \${firstIndex}-\${lastIndex} of \${state.totalUnits}</div>
            <div class="button-row">
              <button type="button" id="reviewPrevPage" \${state.page <= 1 ? "disabled" : ""}>Previous</button>
              <button type="button" id="reviewNextPage" \${state.page >= state.totalPages ? "disabled" : ""}>Next</button>
            </div>
          </div>\`;

        document.getElementById("reviewPrevPage")?.addEventListener("click", async () => {
          if (state.page <= 1) {
            return;
          }
          state.page -= 1;
          await loadState();
        });
        document.getElementById("reviewNextPage")?.addEventListener("click", async () => {
          if (state.page >= state.totalPages) {
            return;
          }
          state.page += 1;
          await loadState();
        });
      }

      function renderEvidenceGroup(title, values) {
        if (!Array.isArray(values) || values.length === 0) {
          return "";
        }
        const inferEvidenceLabel = (groupTitle, rawValue) => {
          const value = String(rawValue || "").trim();
          const match = value.match(/^([a-zA-Z0-9 _-]+)\("([\s\S]*)"\)$/);
          if (match) {
            return {
              key: match[1].replaceAll("_", " "),
              value: match[2],
            };
          }

          const lowerGroup = groupTitle.toLowerCase();
          if (lowerGroup.includes("url")) return { key: "URL", value };
          if (lowerGroup.includes("heading")) return { key: "Heading", value };
          if (lowerGroup.includes("alert")) return { key: "Alert", value };
          if (lowerGroup.includes("term")) return { key: "Term", value };
          if (lowerGroup.includes("prerequisite")) return { key: "Context", value };
          if (lowerGroup.includes("primary")) return { key: "Primary", value };
          if (lowerGroup.includes("outcome")) return { key: "Outcome", value };
          if (lowerGroup.includes("suite")) return { key: "Suite", value };
          if (lowerGroup.includes("test")) return { key: "Test", value };
          if (lowerGroup.includes("browser")) return { key: "Browser", value };
          if (lowerGroup.includes("tool")) return { key: "Tool", value };
          return { key: title.replace(/s$/, ""), value };
        };
        return \`
          <div class="evidence-group">
            <h4>\${escapeHtml(title)}</h4>
            <div class="evidence-rows">\${values.map((value) => {
              const row = inferEvidenceLabel(title, value);
              return \`<div class="evidence-row"><div class="evidence-key">\${escapeHtml(row.key)}</div><div class="evidence-value">\${escapeHtml(row.value)}</div></div>\`;
            }).join("")}</div>
          </div>\`;
      }

      function renderDetail() {
        const detail = document.getElementById("detail");
        const unit = getCurrentUnit();
        const visibleUnits = getVisibleUnits();

        if (!unit) {
          if (state.query && visibleUnits.length === 0) {
            detail.innerHTML = '<p id="empty">No observed behaviors match this search.</p>';
            return;
          }
          const activeUnits = visibleUnits.filter((candidate) => candidate.proposalState === "proposed" || candidate.activeDescriptor);
          if (activeUnits.length === 0) {
            detail.innerHTML = '<p id="empty">Waiting for interpreted flow variants.</p><p><a class="summary-link" href="/review/summary">Open summary readout</a></p>';
          } else if (state.mode === "full") {
            state.selectedId = activeUnits[0].reviewId;
            render();
          } else {
            detail.innerHTML = '<p id="empty">Select a flow variant to review.</p>';
          }
          return;
        }

        const isSubmitting = state.submittingReviewId === unit.reviewId;
        const status = getDisplayStatus(unit);
        const flowSequence = buildFlowSequence(unit);
        const rawStepSequence = (unit.canonical || []).map((step) => humanizeCanonicalStep(step, unit));
        const llmVocab = [...new Set([...(unit.approvedVocabUsed || []), ...(unit.proposedVocab || [])])];
        const evidenceMarkup = [
          renderEvidenceGroup("Alerts", unit.alerts),
          renderEvidenceGroup("Outcome terms", unit.outcomeTerms),
          renderEvidenceGroup("Final URLs", unit.finalUrls),
          renderEvidenceGroup("Terms and vocab", unit.activeVocab),
          renderEvidenceGroup("Primary terms", unit.primaryTerms),
          renderEvidenceGroup("Headings", unit.headings),
          renderEvidenceGroup("Prerequisites", unit.prerequisites),
          renderEvidenceGroup("Targets", unit.targets),
        ].filter(Boolean).join("");
        detail.innerHTML = \`
          \${state.transitionMessage ? \`<div class="transition-banner" role="status">\${escapeHtml(state.transitionMessage)}</div>\` : ""}
          <div class="detail-header">
            <div class="detail-header-top">
              <div>
                <div class="descriptor" id="reviewHeading" tabindex="-1">\${escapeHtml(unit.activeDescriptor || unit.proposedDescriptor || "Pending interpretation")}</div>
                <p class="detail-summary">\${escapeHtml(unit.proposedRationale || unit.proposalError || "No proposal yet.")}</p>
              </div>
              <div class="detail-badges">
                \${status ? \`<span class="badge \${getStatusTone(status)}">\${escapeHtml(status)}</span>\` : ""}
                \${getConfidenceLabel(unit.proposedConfidence) ? \`<span class="badge \${getConfidenceTone(unit.proposedConfidence)}">\${escapeHtml(getConfidenceLabel(unit.proposedConfidence))}</span>\` : ""}
              </div>
            </div>
            <div class="meta-row">
              \${getPrimarySuite(unit) ? \`<span class="meta-item"><strong>Suite</strong> \${escapeHtml(getPrimarySuite(unit))}</span>\` : ""}
              \${getPrimaryTest(unit) ? \`<span class="meta-item"><strong>Test</strong> \${escapeHtml(getPrimaryTest(unit))}</span>\` : ""}
              \${getPrimaryTool(unit) ? \`<span class="meta-item"><strong>Tool</strong> \${escapeHtml(getPrimaryTool(unit))}</span>\` : ""}
              \${getPrimaryBrowser(unit) ? \`<span class="meta-item"><strong>Browser</strong> \${escapeHtml(getPrimaryBrowser(unit))}</span>\` : ""}
              \${getPrimaryFinalUrl(unit) ? \`<span class="meta-item"><strong>Final URL</strong> \${escapeHtml(getPrimaryFinalUrl(unit))}</span>\` : ""}
            </div>
          </div>
          <div class="section-stack">
            <section class="doc-section">
              <h3>Interpreted flow</h3>
              <div class="section-body">
                <p class="section-copy">This behavior was inferred from the captured execution evidence shown below.</p>
                <div class="flow-block">
                  <div class="sequence">
                    \${flowSequence.map((step, index) => \`
                      <span class="sequence-step">\${escapeHtml(step)}</span>\${index < flowSequence.length - 1 ? '<span class="sequence-arrow">→</span>' : ''}
                    \`).join("")}
                  </div>
                </div>
              </div>
            </section>
            <section class="doc-section">
              <h3>Evidence</h3>
              <div class="section-body">
                \${evidenceMarkup ? \`<div class="evidence-grid">\${evidenceMarkup}</div>\` : '<div class="evidence-empty">No supporting evidence captured for this flow yet.</div>'}
              </div>
            </section>
            <section class="doc-section raw-steps">
              <h3>Raw details</h3>
              <details id="rawDetailsPanel" data-preserve-open="true">
                <summary>Raw steps and supporting context</summary>
                <div class="evidence-grid">
                  \${renderEvidenceGroup("Raw steps", rawStepSequence)}
                  \${renderEvidenceGroup("All suites", unit.suites)}
                  \${renderEvidenceGroup("All tests", unit.tests)}
                  \${renderEvidenceGroup("Tools", unit.tools)}
                  \${renderEvidenceGroup("Browsers", unit.browsers)}
                  \${unit.interpretationStatus === "edited" ? renderEvidenceGroup("LLM vocab", llmVocab) : ""}
                </div>
              </details>
            </section>
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

      ${renderUtilityMenuScript()}

      document.getElementById("rebuildReviewUnits")?.addEventListener("click", async () => {
        if (state.rebuilding) {
          return;
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
          state.selectedUnit = null;
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

      function render(options = {}) {
        const preserveDetail = options.preserveDetail === true;
        const preserveListControls = options.preserveListControls === true;
        const openDetailSections = preserveDetail ? [] : getOpenDetailSections();
        const rebuildButton = document.getElementById("rebuildReviewUnits");
        if (rebuildButton) {
          rebuildButton.disabled = state.rebuilding;
          rebuildButton.textContent = state.rebuilding ? "Rebuilding…" : "Rebuild Observed Behaviors";
        }
        if (!preserveListControls) {
          renderListControls();
        }
        renderOverlapSummary();
        renderList();
        renderPagination();
        if (!preserveDetail) {
          renderDetail();
          restoreOpenDetailSections(openDetailSections);
        }
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
      ${renderAppShellStyles()}
      html { scroll-behavior: smooth; }
      main { padding: 20px 24px 36px; display: grid; gap: 12px; background: #fff; }
      .summary-stack { display: grid; gap: 24px; }
      .kpi-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
      .kpi-card {
        display: block;
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 13px 15px;
        position: relative;
        overflow: hidden;
        color: inherit;
        text-decoration: none;
        cursor: pointer;
        transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
      }
      .kpi-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px; background: transparent; }
      .kpi-card:hover { transform: translateY(-1px); border-color: var(--line-strong); box-shadow: none; }
      .kpi-label { color: var(--muted); font-size: 12px; letter-spacing: 0.01em; margin-bottom: 7px; font-weight: 600; }
      .kpi-value { font-family: var(--font-serif); font-size: 28px; font-weight: 600; line-height: 1; letter-spacing: -0.01em; }
      .kpi-card.covered::before { background: rgba(22,101,52,0.28); }
      .kpi-card.covered .kpi-value { color: var(--accent); }
      .kpi-card.partial::before { background: rgba(161,98,7,0.28); }
      .kpi-card.partial .kpi-value { color: var(--warn); }
      .kpi-card.missing::before { background: rgba(185,28,28,0.28); }
      .kpi-card.missing .kpi-value { color: var(--danger); }
      .section-card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 18px 20px;
        scroll-margin-top: 20px;
      }
      .section-header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 8px; }
      .section-header h3 { margin: 0; font-family: var(--font-serif); font-size: 24px; font-weight: 600; line-height: 1.15; }
      .section-note { margin: 0 0 14px; color: var(--muted); font-size: 13px; line-height: 1.55; max-width: 96ch; }
      .metric-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
      .metric-chip {
        padding: 5px 10px;
        border-radius: 999px;
        background: #fff;
        border: 1px solid var(--line);
        font-size: 12px;
        color: var(--muted);
      }
      button.metric-chip { cursor: pointer; font: inherit; transition: border-color 120ms ease, background 120ms ease, transform 120ms ease; }
      button.metric-chip:hover { transform: translateY(-1px); border-color: var(--line-strong); }
      button.metric-chip.active { border-color: var(--ink); color: var(--ink); }
      .metric-chip.all { color: var(--ink); }
      .metric-chip.covered { color: var(--accent); background: var(--accent-soft); border-color: #bbf7d0; }
      .metric-chip.partial { color: var(--warn); background: #fffbeb; border-color: #fde68a; }
      .metric-chip.missing { color: var(--danger); background: #fef2f2; border-color: #fecaca; }
      .empty-note, .meta { color: var(--muted); }
      .flow-summary-list, .unique-list { display: grid; gap: 0; }
      .flow-summary-card, .unique-row {
        display: grid;
        gap: 4px;
        padding: 12px 0;
        border-top: 1px solid var(--line);
        color: inherit;
        text-decoration: none;
      }
      .flow-summary-card:first-child, .unique-row:first-child { border-top: 0; padding-top: 0; }
      .flow-summary-card:hover, .unique-row:hover { color: var(--ink); }
      .flow-summary-title, .unique-title { font-family: var(--font-serif); font-size: 19px; font-weight: 600; line-height: 1.15; letter-spacing: -0.01em; }
      .flow-summary-meta, .unique-meta { color: var(--muted); font-size: 12px; line-height: 1.5; }
      .flow-summary-meta.covered { color: var(--accent); }
      .flow-summary-meta.partial { color: var(--warn); }
      .flow-summary-meta.not_covered, .flow-summary-meta.missing { color: var(--danger); }
      .unique-link { color: inherit; text-decoration: none; }
      .unique-link:hover .unique-title { color: var(--accent); }
      .back { color: var(--accent); text-decoration: none; font-weight: 600; }
      @media (max-width: 900px) {
        .page-utility { position: static; transform: none; margin-top: 12px; }
        .page-utility-panel { right: auto; left: 0; }
        .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        main { padding: 18px; }
      }
    </style>
  </head>
  <body>
    ${renderAppHeader({
      subtitle: "See what was exercised based on observed evidence, and evaluate coverage of critical business flows.",
      active: "summary",
      utilityMarkup: `<div class="page-utility" data-page-utility>
          <button type="button" class="page-utility-trigger" data-page-utility-trigger aria-haspopup="menu" aria-expanded="false">Export <span aria-hidden="true">▾</span></button>
          <div class="page-utility-panel" data-page-utility-panel hidden>
            <button type="button" class="page-utility-option" id="summaryPrintAction" data-page-utility-close>Print / Save as PDF</button>
            <a class="page-utility-option" href="/artifacts/export?format=zip" data-page-utility-close>Download artifact (.zip)</a>
          </div>
        </div>`,
    })}
    <main>
      <div id="summary">Loading…</div>
    </main>
    <script>
      ${renderUtilityMenuScript()}
      document.getElementById("summaryPrintAction")?.addEventListener("click", () => {
        window.print();
      });

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
      const getStructureKey = (unit) => String(unit.structureKey || "").trim();
      const getStructureGroupTitle = (units) => {
        const descriptors = units
          .map((unit) => String(unit.activeDescriptor || unit.proposedDescriptor || unit.canonical.join(" → ")).trim())
          .filter(Boolean);
        if (descriptors.length === 0) {
          return units[0]?.canonical?.join(" → ") || "Observed behavior";
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
      const getUniqueFlows = (units) => {
        const groups = new Map();
        getActiveUnits(units).forEach((unit) => {
          const structureKey = getStructureKey(unit);
          const key = structureKey || unit.reviewId;
          const current = groups.get(key);
          if (!current) {
            groups.set(key, {
              structureKey,
              reviewId: unit.reviewId,
              units: [unit],
              count: 1,
              prerequisites: [...new Set(unit.prerequisites || [])],
            });
            return;
          }

          current.units.push(unit);
          current.count += 1;
          current.prerequisites = [...new Set([...(current.prerequisites || []), ...(unit.prerequisites || [])])];
        });

        return [...groups.values()]
          .map((group) => ({
            kind: group.count > 1 ? "cluster" : "unit",
            structureKey: group.structureKey,
            reviewId: group.reviewId,
            title: getStructureGroupTitle(group.units),
            count: group.count,
            prerequisites: [...new Set(group.prerequisites || [])].sort(),
          }))
          .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
      };
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
        const uniqueFlows = getUniqueFlows(units);
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
              \${renderKpiCard("Unique Behaviors", uniqueFlows.length, "#unique-flows-observed")}
              \${criticalFlows.length > 0 ? renderKpiCard("Covered", coveredCount, "#critical-flow-coverage", coveredCount > 0 ? "covered" : "", "covered") : ""}
              \${criticalFlows.length > 0 ? renderKpiCard("Partial", partialCount, "#critical-flow-coverage", partialCount > 0 ? "partial" : "", "partial") : ""}
              \${criticalFlows.length > 0 ? renderKpiCard("Missing", missingCount, "#critical-flow-coverage", missingCount > 0 ? "missing" : "", "not_covered") : ""}
            </div>

              <section id="unique-flows-observed" class="section-card">
              <div class="section-header">
                <h3>Unique Behaviors</h3>
              </div>
              <p class="section-note">Behaviors exercised during testing. Counts indicate repeated coverage across multiple test scenarios.</p>
              \${uniqueFlows.length > 0 ? \`
                <div class="unique-list">
                  \${uniqueFlows.map((item) => \`
                    \${item.kind === "cluster"
                      ? \`<a class="unique-link unique-row" href="/review?structureKey=\${encodeURIComponent(item.structureKey || "")}&from=summary">
                          <div class="unique-title">\${escapeHtml(item.title)}</div>
                          <div class="unique-meta">\${escapeHtml(item.count === 1 ? "Observed in 1 execution" : \`Observed in \${item.count} executions\`)}</div>
                        </a>\`
                      : \`<a class="unique-link unique-row" href="/review?structureKey=\${encodeURIComponent(item.structureKey || "")}&from=summary">
                          <div class="unique-title">\${escapeHtml(item.title)}</div>
                          <div class="unique-meta">\${escapeHtml(item.count === 1 ? "Observed in 1 execution" : \`Observed in \${item.count} executions\`)}</div>
                        </a>\`}\`).join("")}
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
      ${renderAppShellStyles()}
      header { position: sticky; top: 0; z-index: 10; }
      main { display: grid; grid-template-columns: 320px 1fr; min-height: calc(100vh - 119px); background: #fff; }
      aside { border-right: 1px solid var(--line); padding: 10px 0 16px; overflow: auto; background: #fff; }
      section { padding: 18px 20px; overflow: auto; background: #fff; }
      .rail-section-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 16px 12px; }
      .rail-title { font-size: 12px; color: var(--muted); margin: 0; letter-spacing: 0.01em; font-weight: 600; }
      .gap-summary { display: grid; gap: 8px; margin: 0 16px 18px; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
      .gap-card { border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 9px 11px; cursor: pointer; }
      .gap-card.active { border-color: #fde68a; background: #fffdf5; }
      .gap-term { display: inline-block; font-weight: 700; font-size: 14px; margin-bottom: 4px; }
      .gap-meta { color: var(--muted); font-size: 13px; line-height: 1.45; }
      #flows { display: grid; }
      .flow-card {
        border: 1px solid transparent;
        border-left: 2px solid transparent;
        border-right: 0;
        border-top: 0;
        border-bottom: 1px solid var(--line);
        background: transparent;
        border-radius: 0;
        padding: 10px 16px 10px 18px;
        cursor: pointer;
      }
      .flow-card:hover { background: #f8fafc; }
      .flow-card.active { background: linear-gradient(90deg, rgba(22,101,52,0.05), rgba(255,255,255,1)); border-left-color: var(--accent); }
      .flow-card.related { border-left-color: var(--warn); }
      .flow-card.dimmed { opacity: 0.56; }
      .flow-card h2 { margin: 0 0 7px; font-size: 14px; line-height: 1.28; }
      .status-chip {
        display: inline-flex;
        align-items: center;
        padding: 4px 9px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: #fff;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.2;
      }
      .status-chip.covered { background: var(--accent-soft); color: var(--accent); border-color: #bbf7d0; }
      .status-chip.partial { background: #fffbeb; color: var(--warn); border-color: #fde68a; }
      .status-chip.not_covered { background: #fef2f2; color: var(--danger); border-color: #fecaca; }
      .missing-preview { margin-top: 8px; font-size: 12px; line-height: 1.4; color: var(--muted); }
      .missing-preview strong { color: var(--danger); }
      .panel { background: var(--panel); border: 1px solid #e8edf5; border-radius: 12px; padding: 20px 22px; }
      .stack { display: grid; gap: 18px; }
      .intro h2, .detail-header h2 { margin: 0 0 6px; font-family: var(--font-serif); font-size: 27px; font-weight: 600; line-height: 1.08; letter-spacing: -0.01em; }
      .intro p, .detail-header p, .meta { color: var(--muted); margin: 0; line-height: 1.5; }
      .example-list { margin: 12px 0 0; padding-left: 18px; }
      .form-grid { display: grid; gap: 12px; }
      .field-label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 700; color: var(--ink); letter-spacing: 0.01em; }
      textarea, input, button { font: inherit; }
      textarea, input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: #fff; color: var(--ink); }
      textarea { min-height: 96px; resize: vertical; }
      .button-row { display: flex; gap: 10px; flex-wrap: wrap; }
      button { border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; cursor: pointer; background: #fff; color: var(--ink); }
      button:hover:not(:disabled) { border-color: var(--line-strong); background: #f8fafc; }
      button.primary { background: var(--accent); color: white; border-color: var(--accent); }
      button.primary:hover:not(:disabled) { background: #14532d; border-color: #14532d; }
      button.ghost-link { background: transparent; padding: 0; color: var(--accent); text-decoration: underline; }
      button:disabled { opacity: 0.6; cursor: wait; }
      .interpretation, .callout, .suggestions, .duplicate-warning {
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 16px;
        background: #fff;
      }
      .interpretation label + label { display: block; margin-top: 14px; }
      .duplicate-warning { border-color: #fde68a; background: #fffbeb; }
      .duplicate-warning h3 { margin: 0 0 8px; font-size: 18px; }
      .duplicate-match { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 12px; }
      .duplicate-match:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
      .duplicate-label { color: var(--muted); font-size: 13px; margin-bottom: 6px; }
      .callout { background: #fcfdff; }
      .error { color: var(--danger); }
      .add-flow-bar { display: flex; justify-content: flex-start; margin-bottom: 18px; }
      .add-flow-button { border: 1px solid var(--line); background: transparent; color: var(--accent); font-weight: 600; }
      .rail-add-button { padding: 6px 10px; border-radius: 999px; font-size: 12px; line-height: 1.2; white-space: nowrap; }
      .modal-backdrop { position: fixed; inset: 0; background: rgba(15,23,42,0.28); display: flex; align-items: flex-start; justify-content: center; padding: 48px 20px; z-index: 20; overflow-y: auto; }
      .modal-card { position: relative; width: min(760px, 100%); max-height: calc(100vh - 96px); overflow-y: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 20px; box-shadow: 0 24px 60px rgba(15,23,42,0.18); }
      .modal-shell { position: relative; padding-top: 18px; }
      .modal-close { position: absolute; top: 0; right: 0; border: 1px solid var(--line); background: rgba(255,255,255,0.94); color: var(--muted); width: 30px; height: 30px; padding: 0; border-radius: 999px; font-size: 18px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; box-shadow: 0 4px 16px rgba(15,23,42,0.08); }
      .modal-close:hover { color: var(--ink); border-color: var(--line); }
      .detail-meta { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
      .detail-status { margin-top: 2px; }
      .detail-summary { margin-top: 6px; max-width: 72ch; font-size: 14px; }
      .detail-actions { margin-top: 8px; }
      .detail-section { padding-top: 14px; border-top: 1px solid var(--line); display: grid; gap: 7px; }
      .detail-section h3 { margin: 0; font-family: var(--font-serif); font-size: 20px; font-weight: 600; line-height: 1.15; color: var(--ink); }
      .detail-section p { margin: 0; }
      .detail-support { margin-top: 0; color: var(--muted); }
      .detail-link { color: var(--accent); text-decoration: none; font-weight: 600; }
      .detail-link:hover { text-decoration: underline; }
      .definition-list { display: grid; gap: 6px; }
      .definition-row { display: grid; grid-template-columns: 140px 1fr; gap: 12px; padding-top: 7px; border-top: 1px solid var(--line); }
      .definition-row:first-child { border-top: 0; padding-top: 0; }
      .definition-term { color: var(--muted); font-size: 12px; letter-spacing: 0.01em; }
      .definition-value { color: var(--ink); }
      ul { margin: 0; padding-left: 18px; }
      li { margin: 4px 0; overflow-wrap: anywhere; word-break: break-word; }
      .pills { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
      .pill { border: 1px solid var(--line); border-radius: 999px; background: #fff; padding: 8px 12px; cursor: pointer; }
      .empty-note { color: var(--muted); }
      @media (max-width: 900px) {
        main { grid-template-columns: 1fr; }
        aside { border-right: 0; border-bottom: 1px solid var(--line); }
        section { padding: 16px; }
        .panel { padding: 18px 16px; }
        .definition-row { grid-template-columns: 1fr; gap: 4px; }
      }
    </style>
  </head>
  <body>
    ${renderAppHeader({
      subtitle: "Define expected behaviors and evaluate them against observed execution evidence.",
      active: "expected",
    })}
    <main>
      <aside>
        <div id="gapSummary"></div>
        <div class="rail-section-header">
          <p class="rail-title">Saved Expected Behaviors</p>
          <div id="railActions"></div>
        </div>
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
            <p class="rail-title">Missing Coverage</p>
            \${gaps.map((gap) => \`
              <article class="gap-card \${gap.term === state.activeGapTerm ? "active" : ""}" data-term="\${escapeHtml(gap.term)}">
                <div class="gap-term">\${escapeHtml(gap.term)}</div>
                <div class="gap-meta">\${gap.flows.length === 1 ? "Expected behavior not observed in:" : \`Expected behavior not observed in \${escapeHtml(String(gap.flows.length))} flows:\`}</div>
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

      function renderRailActions() {
        const container = document.getElementById("railActions");
        if (state.flows.length === 0) {
          container.innerHTML = "";
          return;
        }

        container.innerHTML = '<button type="button" class="add-flow-button rail-add-button" id="openCriticalFlowForm">+ Add</button>';
        container.querySelector("#openCriticalFlowForm")?.addEventListener("click", () => {
          state.showDraftForm = true;
          state.editingFlowId = null;
          state.editingBaseline = null;
          state.draftText = "";
          state.parsedDraft = null;
          state.error = "";
          render();
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
        const formattedQualifiers = behaviorQualifiers.map((term) => term.replaceAll("_", " "));
        const expectedIntentLabel = behaviorAction
          ? (formattedQualifiers.length > 0
              ? behaviorAction + " (" + formattedQualifiers.join(", ") + ")"
              : behaviorAction)
          : interpretedBehavior[0] || flow.name;
        const statusText = flow.status === "covered"
          ? "Covered"
          : flow.status === "partial"
            ? "Partially Covered"
            : "Not Covered";
        const renderObservedBehaviorLink = (label) => {
          if (!label) {
            return "";
          }
          const href = \`/review?q=\${encodeURIComponent(label)}\`;
          return \`<a class="detail-link" href="\${href}">\${escapeHtml(label)}</a>\`;
        };
        const closestObservedMarkup = flow.matchedAction
          ? \`<p><strong>Closest observed behavior:</strong> \${renderObservedBehaviorLink(flow.matchedAction)}</p>\`
          : "";
        const coverageResultMarkup = flow.status === "covered"
          ? \`<p>Coverage confirmed.</p>\${closestObservedMarkup}\`
          : flow.status === "partial"
            ? \`<p>Partial match detected.</p>
               \${flow.matchedAction ? \`<p><strong>Matched behavior:</strong> \${renderObservedBehaviorLink(flow.matchedAction)}</p>\` : ""}
               \${flow.missingQualifiers.length > 0
                 ? \`<p><strong>Missing qualifiers:</strong> \${escapeHtml(flow.missingQualifiers.map((term) => term.replaceAll("_", " ")).join(", "))}</p>\`
                 : ""}
               <p class="detail-support">Potential causes: qualifier-specific coverage missing or naming mismatch.</p>\`
            : \`<p>Missing coverage.</p>
               \${closestObservedMarkup}
               <p class="detail-support">Potential causes: missing test coverage, naming mismatch, or low-confidence interpretation.</p>\`;
        return \`
          <div class="stack">
            <div class="detail-header">
              <h2>\${escapeHtml(flow.name)}</h2>
              <div class="detail-meta">
                <span class="status-chip \${escapeHtml(flow.status)}">\${escapeHtml(statusText)}</span>
              </div>
              <div class="button-row detail-actions">
                <button type="button" id="editCriticalFlow">Edit</button>
                <button type="button" id="deleteCriticalFlow">Delete</button>
              </div>
            </div>
            <div class="detail-section">
              <h3>Expected Intent</h3>
              <p><strong>\${escapeHtml(expectedIntentLabel)}</strong></p>
              \${interpretedBehavior.length > 1 ? \`<p class="detail-support">\${escapeHtml(interpretedBehavior.join(" • "))}</p>\` : ""}
            </div>
            <div class="detail-section">
              <h3>Coverage Result</h3>
              \${coverageResultMarkup}
            </div>
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
            ? ""
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
        renderRailActions();
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
      const format = formatParam === "zip" ? "zip" : null;
      if (!format) {
        writeJson(res, 400, { error: "Export format must be 'zip'" });
        return;
      }

      const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-export-"));
      const outputPath = path.join(tempDir, DEFAULT_EXPORT_FILE_NAMES[format]);
      try {
        const generatedPath = await exportArtifact({
          format,
          outputPath,
        });
        const fileBuffer = await readFile(generatedPath);
        const contentType = "application/zip";
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

  if (req.method === "GET" && requestPath?.startsWith("/fonts/")) {
    const relativePath = decodeURIComponent(requestPath.slice("/fonts/".length));
    const normalizedPath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
    const absolutePath = path.join(process.cwd(), "public", "fonts", normalizedPath);

    if (!absolutePath.startsWith(path.join(process.cwd(), "public", "fonts"))) {
      writeJson(res, 400, { error: "Invalid font path" });
      return;
    }

    try {
      const content = await readFile(absolutePath);
      const contentType = absolutePath.endsWith(".woff2")
        ? "font/woff2"
        : absolutePath.endsWith(".txt")
          ? "text/plain; charset=utf-8"
          : "application/octet-stream";
      res.writeHead(200, { "content-type": contentType, "cache-control": "public, max-age=31536000, immutable" });
      res.end(content);
    } catch {
      writeJson(res, 404, { error: "Font not found" });
    }
    return;
  }

  if (req.method === "GET" && requestPath === "/review/units") {
    writeJson(res, 200, await loadReviewUnitViews());
    return;
  }

  if (req.method === "GET" && requestPath === "/review/units/meta") {
    const total = await getReviewUnitViewCount();
    writeJson(res, 200, {
      total,
      threshold: REVIEW_PAGINATION_THRESHOLD,
      pageSize: REVIEW_PAGE_SIZE,
      mode: total >= REVIEW_PAGINATION_THRESHOLD ? "scaled" : "full",
    });
    return;
  }

  if (req.method === "GET" && requestPath === "/review/units/query") {
    const page = Number.parseInt(requestUrl?.searchParams.get("page") ?? "1", 10);
    const pageSize = Number.parseInt(requestUrl?.searchParams.get("pageSize") ?? String(REVIEW_PAGE_SIZE), 10);
    const query = requestUrl?.searchParams.get("q") ?? "";
    const structureKey = requestUrl?.searchParams.get("structureKey") ?? "";
    writeJson(
      res,
      200,
      await queryReviewUnitViews({
        page,
        pageSize,
        query,
        structureKey,
      })
    );
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

  if (req.method === "GET" && requestPath?.startsWith("/review/units/")) {
    const reviewId = decodeURIComponent(requestPath.slice("/review/units/".length));
    const unit = await loadReviewUnitView(reviewId);
    if (!unit) {
      writeJson(res, 404, { error: "Review unit not found" });
      return;
    }

    writeJson(res, 200, unit);
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
startMemoryLogging();
void queueProposalProcessing();

server.listen(PORT, HOST, () => {
  console.log(`WDYT server listening on http://${HOST}:${PORT}`);
});
