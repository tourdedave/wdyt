import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const serverEntry = path.join(repoRoot, "dist", "server", "index.js");
const cliEntry = path.join(repoRoot, "dist", "cli", "index.js");

function randomPort() {
  return 4100 + Math.floor(Math.random() * 1000);
}

async function waitForHealth(serverUrl, timeoutMs = 10_000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${serverUrl}/health`);

      if (response.ok) {
        return;
      }
    } catch {
      // Server not ready yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Server did not become healthy within ${timeoutMs}ms`);
}

async function postJson(serverUrl, pathname, payload) {
  const response = await fetch(`${serverUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(`${pathname} failed with status ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

async function postJsonAllowError(serverUrl, pathname, payload) {
  const response = await fetch(`${serverUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

async function getJson(serverUrl, pathname, headers = {}) {
  const response = await fetch(`${serverUrl}${pathname}`, { headers });
  const body = await response.json();

  if (!response.ok) {
    throw new Error(`${pathname} failed with status ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

function spawnServer(workdir, port) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: workdir,
    env: {
      ...process.env,
      WDIT_HOST: "127.0.0.1",
      WDIT_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  return {
    child,
    getOutput: () => output,
  };
}

async function stopChildProcess(child) {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");

  const closed = await Promise.race([
    new Promise((resolve) => child.once("close", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);

  if (closed) {
    return;
  }

  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("close", resolve));
}

async function runCliFlows(workdir) {
  const child = spawn(process.execPath, [cliEntry, "flows"], {
    cwd: workdir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(`CLI exited with code ${exitCode}: ${stderr}`);
  }

  return stdout.trim();
}

test("run lifecycle persists and reduces a bound browser flow", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdit-integration-"));
  const port = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const { child, getOutput } = spawnServer(tempDir, port);

  try {
    await waitForHealth(serverUrl);

    const started = await postJson(serverUrl, "/runs/start", {
      suiteName: "integration",
      testName: "search flow",
    });

    assert.match(started.runId, /^[0-9a-f-]{36}$/);
    assert.equal(
      started.bootstrapUrl,
      `${serverUrl}/bootstrap?serverUrl=${encodeURIComponent(serverUrl)}&runId=${encodeURIComponent(started.runId)}`
    );

    await fetch(started.bootstrapUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.178 Safari/537.36",
      },
    }).then((response) => response.text());

    const bound = await postJson(serverUrl, "/bindings/bind", {
      browserSessionId: "browser-session-1",
      runId: started.runId,
    });

    assert.equal(bound.ok, true);
    assert.equal(bound.run.id, started.runId);
    assert.equal(bound.status, "bound");
    assert.deepEqual(bound.environment, {
      browser: {
        family: "chromium",
        version: "146.0.7680.178",
        source: "bootstrap-request",
      },
    });

    const currentBeforeEnd = await getJson(serverUrl, "/bindings/current?browserSessionId=browser-session-1");

    assert.equal(currentBeforeEnd.bound, true);
    assert.equal(currentBeforeEnd.run.id, started.runId);
    assert.equal(currentBeforeEnd.status, "bound");
    assert.deepEqual(currentBeforeEnd.environment, {
      browser: {
        family: "chromium",
        version: "146.0.7680.178",
        source: "bootstrap-request",
      },
    });

    const ended = await postJson(serverUrl, "/runs/end", {
      runId: started.runId,
      reason: "completed",
    });

    assert.equal(ended.ok, true);

    const currentAfterEnd = await getJson(serverUrl, "/bindings/current?browserSessionId=browser-session-1");

    assert.equal(currentAfterEnd.bound, true);
    assert.equal(currentAfterEnd.run.id, started.runId);
    assert.equal(currentAfterEnd.status, "ending");

    const ingested = await postJson(serverUrl, "/ingest", {
      suite: bound.suite,
      environment: bound.environment,
      run: {
        id: started.runId,
        testName: "search flow",
        startedAt: 0,
        endedAt: 1,
        reason: "completed",
      },
      events: [
        { type: "navigate", ts: 1000, seq: 0, url: "https://www.google.com/ncr" },
        { type: "click", ts: 1010, seq: 1, target: { tag: "textarea", text: "Search" } },
        { type: "click", ts: 1020, seq: 2, target: { tag: "textarea", text: "Search" } },
        { type: "input", ts: 1030, seq: 3, target: { tag: "textarea", text: "wdit testing" } },
        { type: "input", ts: 1040, seq: 4, target: { tag: "textarea", text: "wdit testing" } },
        { type: "submit", ts: 1050, seq: 5, target: { tag: "form", text: null } },
      ],
    });

    assert.equal(ingested.ok, true);
    assert.match(ingested.flowId, /^[0-9a-f]{16}$/);

    const currentAfterIngest = await getJson(serverUrl, "/bindings/current?browserSessionId=browser-session-1");

    assert.deepEqual(currentAfterIngest, { bound: false });

    const rawRuns = await readFile(path.join(tempDir, ".wdit", "runs.raw.jsonl"), "utf8");
    const processedRuns = await readFile(path.join(tempDir, ".wdit", "runs.processed.jsonl"), "utf8");

    assert.match(rawRuns, /"id":"integration"/);
    assert.match(rawRuns, new RegExp(`"id":"${started.runId}"`));
    assert.match(rawRuns, /"family":"chromium"/);
    assert.match(rawRuns, /"version":"146.0.7680.178"/);
    assert.match(processedRuns, /"canonical":\["NAVIGATE","CLICK","INPUT","SUBMIT"\]/);
    assert.match(processedRuns, /"family":"chromium"/);

    const flowsOutput = await runCliFlows(tempDir);
    assert.equal(flowsOutput, "NAVIGATE → CLICK → INPUT → SUBMIT (1)");
  } finally {
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.match(getOutput(), /WDIT server listening/);
});

test("API validation rejects missing required fields and accepts omitted optional metadata", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdit-validation-"));
  const port = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const { child, getOutput } = spawnServer(tempDir, port);

  try {
    await waitForHealth(serverUrl);

    const missingSuite = await postJsonAllowError(serverUrl, "/runs/start", {
      testName: "missing suite",
    });
    assert.equal(missingSuite.status, 400);
    assert.equal(missingSuite.body.error, "Invalid start run payload");

    const missingTestName = await postJsonAllowError(serverUrl, "/runs/start", {
      suiteName: "integration",
    });
    assert.equal(missingTestName.status, 400);
    assert.equal(missingTestName.body.error, "Invalid start run payload");

    const started = await postJson(serverUrl, "/runs/start", {
      suiteName: "validation",
      testName: "optional metadata omitted",
    });
    assert.match(started.runId, /^[0-9a-f-]{36}$/);

    const missingBrowserSession = await postJsonAllowError(serverUrl, "/bindings/bind", {
      runId: started.runId,
    });
    assert.equal(missingBrowserSession.status, 400);
    assert.equal(missingBrowserSession.body.error, "Invalid bind payload");

    const bound = await postJson(serverUrl, "/bindings/bind", {
      browserSessionId: "validation-browser",
      runId: started.runId,
    });

    assert.equal(bound.ok, true);
    assert.equal(bound.environment, undefined);

    const missingRunIdOnEnd = await postJsonAllowError(serverUrl, "/runs/end", {
      reason: "completed",
    });
    assert.equal(missingRunIdOnEnd.status, 400);
    assert.equal(missingRunIdOnEnd.body.error, "Invalid end run payload");

    const current = await getJson(serverUrl, "/bindings/current?browserSessionId=validation-browser");
    assert.equal(current.bound, true);
    assert.equal(current.environment, undefined);
  } finally {
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.match(getOutput(), /WDIT server listening/);
});
