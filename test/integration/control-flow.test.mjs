import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function spawnServer(workdir, port, extraEnv = {}) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: workdir,
    env: {
      ...process.env,
      WDYT_HOST: "127.0.0.1",
      WDYT_PORT: String(port),
      ...extraEnv,
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

async function waitForCondition(check, timeoutMs = 10_000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const result = await check();
    if (result) {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
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

async function runCliFlows(workdir, options = { verbose: false }) {
  const args = ["flows"];

  if (options.verbose) {
    args.push("--verbose");
  }

  return runCli(workdir, args);
}

async function runCli(workdir, args, stdinText = "", env = {}) {
  const child = spawn(process.execPath, [cliEntry, ...args], {
    cwd: workdir,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  if (stdinText) {
    const responses = stdinText.split("\n").filter((value) => value.length > 0);
    const promptPattern = /Action \[a=approve, e=edit\/override, r=reject, s=skip, q=quit]: $/;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for review prompt. stdout=${stdout} stderr=${stderr}`));
      }, 5_000);

      const maybeSend = () => {
        if (!promptPattern.test(stdout)) {
          return;
        }

        const nextResponse = responses.shift();
        if (nextResponse === undefined) {
          clearTimeout(timeout);
          child.stdin.end();
          resolve(undefined);
          return;
        }

        child.stdin.write(`${nextResponse}\n`);

        if (responses.length === 0) {
          clearTimeout(timeout);
          child.stdin.end();
          resolve(undefined);
        }
      };

      child.stdout.on("data", maybeSend);
      maybeSend();
    });
  } else {
    child.stdin.end();
  }

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(`CLI exited with code ${exitCode}: ${stderr}`);
  }

  return stdout.trim();
}

async function startMockLlmServer(port, options = {}) {
  const responseContent = options.responseContent ?? {
    descriptor: "search ends at dashboard",
    approvedVocab: [],
    proposedVocab: ["search"],
    confidence: 0.87,
    rationale: "The flow ends at Dashboard and includes search interactions.",
  };
  const responseSequence = [...(options.responseSequence ?? [])];
  const onRequest = options.onRequest ?? (() => {});

  const handler = async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const parsedBody = JSON.parse(body);
        onRequest(parsedBody);
        const nextContent = responseSequence.shift() ?? responseContent;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: Date.now(),
            model: "mistral:instruct",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify(nextContent),
                },
                finish_reason: "stop",
              },
            ],
          })
        );
      });
      return;
    }

    res.writeHead(404);
    res.end();
  };

  const http = await import("node:http");
  const server = http.createServer(handler);

  await new Promise((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  return server;
}

test("shared prefix suppression handles repeated setup prefixes and preserves a non-empty primary flow", async () => {
  const { collectPrefixStats, suppressSharedPrefix } = await import(path.join(repoRoot, "dist", "shared", "flow-suppression.js"));
  const vocabulary = [];
  const stats = collectPrefixStats(
    [
      ["NAVIGATE", "INPUT", "CHANGE", "CLICK", "SUBMIT"],
      ["NAVIGATE", "INPUT", "CHANGE", "CLICK", "NAVIGATE"],
      ["NAVIGATE", "INPUT", "CHANGE", "SUBMIT", "NAVIGATE"],
      ["CLICK", "SUBMIT"],
    ],
    vocabulary,
    { maxPrefixLength: 3 }
  );

  const suppressed = suppressSharedPrefix(["NAVIGATE", "INPUT", "CHANGE", "CLICK", "SUBMIT"], stats, {
    minFrequencyPct: 0.5,
    maxPrefixLength: 3,
  });

  assert.deepEqual(suppressed.prerequisites, ["NAVIGATE", "INPUT", "CHANGE"]);
  assert.deepEqual(suppressed.primary, ["CLICK", "SUBMIT"]);

  const unsuppressed = suppressSharedPrefix(["CLICK", "SUBMIT"], stats, {
    minFrequencyPct: 0.5,
    maxPrefixLength: 3,
  });

  assert.deepEqual(unsuppressed.prerequisites, []);
  assert.deepEqual(unsuppressed.primary, ["CLICK", "SUBMIT"]);

  const singleStep = suppressSharedPrefix(["NAVIGATE"], stats, {
    minFrequencyPct: 0.5,
    maxPrefixLength: 3,
  });
  assert.deepEqual(singleStep.prerequisites, []);
  assert.deepEqual(singleStep.primary, ["NAVIGATE"]);
});

test("shared prefix suppression supports length 1 prefixes and skips non-shared flows", async () => {
  const { collectPrefixStats, suppressSharedPrefix } = await import(path.join(repoRoot, "dist", "shared", "flow-suppression.js"));
  const vocabulary = [];
  const stats = collectPrefixStats(
    [
      ["NAVIGATE", "CLICK", "SUBMIT"],
      ["NAVIGATE", "INPUT", "SUBMIT"],
      ["NAVIGATE", "CHANGE", "CLICK"],
    ],
    vocabulary,
    { maxPrefixLength: 3 }
  );

  const suppressed = suppressSharedPrefix(["NAVIGATE", "CLICK", "SUBMIT"], stats, {
    minFrequencyPct: 0.5,
    maxPrefixLength: 3,
  });
  assert.deepEqual(suppressed.prerequisites, ["NAVIGATE"]);
  assert.deepEqual(suppressed.primary, ["CLICK", "SUBMIT"]);

  const noSharedStats = collectPrefixStats(
    [
      ["CLICK", "SUBMIT"],
      ["INPUT", "CHANGE"],
      ["NAVIGATE", "SUBMIT"],
    ],
    vocabulary,
    { maxPrefixLength: 3 }
  );
  const notSuppressed = suppressSharedPrefix(["CLICK", "SUBMIT"], noSharedStats, {
    minFrequencyPct: 0.5,
    maxPrefixLength: 3,
  });
  assert.deepEqual(notSuppressed.prerequisites, []);
  assert.deepEqual(notSuppressed.primary, ["CLICK", "SUBMIT"]);
});

test("review unit views expose prerequisites and primary flow after shared-prefix suppression", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-review-view-suppression-"));
  const dataDir = path.join(tempDir, ".wdyt");
  const originalCwd = process.cwd();

  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(dataDir, "review-units.json"),
      `${JSON.stringify(
        [
          {
            reviewId: "flow-a",
            flowId: "flow-a",
            canonical: ["NAVIGATE", "INPUT", "CHANGE", "CLICK", "SUBMIT"],
            count: 1,
            suites: ["integration"],
            tests: ["flow-a"],
            tools: ["integration-test"],
            browsers: ["chromium 146"],
            urls: [],
            targets: [],
            finalUrls: [],
            titles: [],
            headings: [],
            alerts: [],
            proposalState: "proposed",
            approvedVocabUsed: [],
            proposedVocab: ["task a"],
            activeDescriptor: "Task A",
            activeVocab: ["task a"],
            updatedAt: 1,
          },
          {
            reviewId: "flow-b",
            flowId: "flow-b",
            canonical: ["NAVIGATE", "INPUT", "CHANGE", "CLICK", "NAVIGATE"],
            count: 1,
            suites: ["integration"],
            tests: ["flow-b"],
            tools: ["integration-test"],
            browsers: ["chromium 146"],
            urls: [],
            targets: [],
            finalUrls: [],
            titles: [],
            headings: [],
            alerts: [],
            proposalState: "proposed",
            approvedVocabUsed: [],
            proposedVocab: ["task b"],
            activeDescriptor: "Task B",
            activeVocab: ["task b"],
            updatedAt: 1,
          },
          {
            reviewId: "flow-c",
            flowId: "flow-c",
            canonical: ["NAVIGATE", "INPUT", "CHANGE", "SUBMIT", "NAVIGATE"],
            count: 1,
            suites: ["integration"],
            tests: ["flow-c"],
            tools: ["integration-test"],
            browsers: ["chromium 146"],
            urls: [],
            targets: [],
            finalUrls: [],
            titles: [],
            headings: [],
            alerts: [],
            proposalState: "proposed",
            approvedVocabUsed: [],
            proposedVocab: ["task c"],
            activeDescriptor: "Task C",
            activeVocab: ["task c"],
            updatedAt: 1,
          },
        ],
        null,
        2
      )}\n`,
      "utf8"
    );

    process.chdir(tempDir);
    const { loadReviewUnitViews } = await import(path.join(repoRoot, "dist", "server", "review.js"));
    const views = await loadReviewUnitViews();
    const flowA = views.find((unit) => unit.reviewId === "flow-a");

    assert.ok(flowA);
    assert.deepEqual(flowA.prerequisites, ["NAVIGATE", "INPUT", "CHANGE"]);
    assert.deepEqual(flowA.primaryCanonical, ["CLICK", "SUBMIT"]);
  } finally {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run lifecycle persists and reduces a bound browser flow", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-integration-"));
  const port = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const { child, getOutput } = spawnServer(tempDir, port);

  try {
    await waitForHealth(serverUrl);

    const started = await postJson(serverUrl, "/runs/start", {
      suiteName: "integration",
      testName: "search flow",
      environment: {
        tool: "integration-test",
      },
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
      tool: "integration-test",
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
      tool: "integration-test",
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
      endState: {
        finalUrl: "http://127.0.0.1:4010/dashboard",
        title: "Dashboard",
        heading: "Dashboard",
        alertText: null,
      },
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
        { type: "input", ts: 1030, seq: 3, target: { tag: "textarea", text: "wdyt testing" } },
        { type: "input", ts: 1040, seq: 4, target: { tag: "textarea", text: "wdyt testing" } },
        { type: "submit", ts: 1050, seq: 5, target: { tag: "form", text: null } },
      ],
    });

    assert.equal(ingested.ok, true);
    assert.match(ingested.flowId, /^[0-9a-f]{16}$/);

    const currentAfterIngest = await getJson(serverUrl, "/bindings/current?browserSessionId=browser-session-1");

    assert.deepEqual(currentAfterIngest, { bound: false });

    const rawRuns = await readFile(path.join(tempDir, ".wdyt", "runs.raw.jsonl"), "utf8");
    const processedRuns = await readFile(path.join(tempDir, ".wdyt", "runs.processed.jsonl"), "utf8");

    assert.match(rawRuns, /"id":"integration"/);
    assert.match(rawRuns, new RegExp(`"id":"${started.runId}"`));
    assert.match(rawRuns, /"tool":"integration-test"/);
    assert.match(rawRuns, /"family":"chromium"/);
    assert.match(rawRuns, /"version":"146.0.7680.178"/);
    assert.match(rawRuns, /"finalUrl":"http:\/\/127\.0\.0\.1:4010\/dashboard"/);
    assert.match(processedRuns, /"canonical":\["NAVIGATE","CLICK","INPUT","SUBMIT"\]/);
    assert.match(processedRuns, /"tool":"integration-test"/);
    assert.match(processedRuns, /"family":"chromium"/);
    assert.match(processedRuns, /"heading":"Dashboard"/);

    const flowsOutput = await runCliFlows(tempDir);
    assert.match(flowsOutput, /^Count\s+Suites\s+Tests\s+Tool\s+Browser\s+Flow/m);
    assert.match(flowsOutput, /1\s+integration\s+search flow\s+integration-test\s+chromium 146\.0\.7680\.178\s+NAVIGATE → CLICK → INPUT → SUBMIT/);

    const verboseFlowsOutput = await runCliFlows(tempDir, { verbose: true });
    assert.match(verboseFlowsOutput, /URLs:\n\s+- https:\/\/www\.google\.com\/ncr/);
    assert.match(verboseFlowsOutput, /Final URLs:\n\s+- http:\/\/127\.0\.0\.1:4010\/dashboard/);
    assert.match(verboseFlowsOutput, /Titles:\n\s+- Dashboard/);
    assert.match(verboseFlowsOutput, /Headings:\n\s+- Dashboard/);
    assert.match(verboseFlowsOutput, /Alerts:\n\s+- -/);
    assert.match(verboseFlowsOutput, /Targets:\n\s+- form\n\s+- textarea\("Search"\)\n\s+- textarea\("wdyt testing"\)/);

    const reviewOutput = await runCli(tempDir, ["review"], "a\n");
    assert.match(reviewOutput, /Proposed descriptor:/);

    const reviewFile = await readFile(path.join(tempDir, ".wdyt", "flow-reviews.json"), "utf8");
    assert.match(reviewFile, /"descriptorStatus": "approved"/);
    assert.match(reviewFile, /"approvedDescriptor": "Review flow ending at Dashboard/);
  } finally {
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.match(getOutput(), /WDYT server listening/);
});

test("review --propose stores LLM-backed descriptor proposals", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-review-"));
  const port = randomPort();
  const llmPort = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const llmUrl = `http://127.0.0.1:${llmPort}/v1`;
  const { child } = spawnServer(tempDir, port);
  const llmServer = await startMockLlmServer(llmPort);

  try {
    await waitForHealth(serverUrl);

    const started = await postJson(serverUrl, "/runs/start", {
      suiteName: "integration",
      testName: "proposal flow",
      environment: {
        tool: "integration-test",
      },
    });

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

    await postJson(serverUrl, "/runs/end", {
      runId: started.runId,
      reason: "completed",
    });

    await postJson(serverUrl, "/ingest", {
      suite: bound.suite,
      environment: bound.environment,
      endState: {
        finalUrl: "http://127.0.0.1:4010/dashboard",
        title: "Dashboard",
        heading: "Dashboard",
        alertText: null,
      },
      run: {
        id: started.runId,
        testName: "proposal flow",
        startedAt: 0,
        endedAt: 1,
        reason: "completed",
      },
      events: [
        { type: "navigate", ts: 1000, seq: 0, url: "http://127.0.0.1:4010/login" },
        { type: "click", ts: 1010, seq: 1, target: { tag: "button", text: "Search" } },
      ],
    });

    const reviewOutput = await runCli(
      tempDir,
      ["review", "--propose"],
      "a\n",
      {
        WDYT_LLM_BASE_URL: llmUrl,
        WDYT_LLM_API_KEY: "ollama",
        WDYT_LLM_MODEL: "mistral:instruct",
      }
    );

    assert.match(reviewOutput, /Confidence: 0\.87/);
    assert.match(reviewOutput, /Rationale: The flow ends at Dashboard and includes search interactions\./);
    assert.match(reviewOutput, /Approved vocab: -/);
    assert.match(reviewOutput, /Proposed vocab: search/);

    const reviewFile = await readFile(path.join(tempDir, ".wdyt", "flow-reviews.json"), "utf8");
    assert.match(reviewFile, /"proposedDescriptor": "search ends at dashboard"/);
    assert.match(reviewFile, /"proposedConfidence": 0.87/);
    assert.match(reviewFile, /"proposedRationale": "The flow ends at Dashboard and includes search interactions\."/);
    assert.match(reviewFile, /"approvedVocabUsed": \[\]/);
    assert.match(reviewFile, /"proposedVocab": \[\n\s+"search"\n\s+\]/);
  } finally {
    llmServer.close();
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("review proposal prompt uses registry matches and canonical approved vocabulary", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-review-sanitize-"));
  const port = randomPort();
  const llmPort = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const llmUrl = `http://127.0.0.1:${llmPort}/v1`;
  const { child } = spawnServer(tempDir, port);
  let capturedRequest = null;
  const llmServer = await startMockLlmServer(llmPort, {
    responseContent: {
      descriptor: "User enters search query 'wdyt testing' and receives an error message on Google Search",
      approvedVocab: ["google search"],
      proposedVocab: ["error message", "search query"],
      confidence: 0.8,
      rationale: "The flow shows a search followed by an error page.",
    },
    onRequest: (body) => {
      capturedRequest ??= body;
    },
  });

  try {
    await waitForHealth(serverUrl);

    await postJson(serverUrl, "/review/vocabulary", {
      term: "Google Search",
      status: "approved",
      aliases: ["google search", "google"],
    });

    const started = await postJson(serverUrl, "/runs/start", {
      suiteName: "integration",
      testName: "search error flow",
      environment: { tool: "integration-test" },
    });

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

    await postJson(serverUrl, "/runs/end", {
      runId: started.runId,
      reason: "completed",
    });

    await postJson(serverUrl, "/ingest", {
      suite: bound.suite,
      environment: bound.environment,
      endState: {
        finalUrl: "https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dwdyt%2Btesting",
        title: "Google Search",
        heading: null,
        alertText: "There was an error",
      },
      run: {
        id: started.runId,
        testName: "search error flow",
        startedAt: 0,
        endedAt: 1,
        reason: "completed",
      },
      events: [
        { type: "navigate", ts: 1000, seq: 0, url: "https://www.google.com/ncr" },
        { type: "click", ts: 1010, seq: 1, target: { tag: "textarea", text: "Search" } },
        { type: "input", ts: 1020, seq: 2, target: { tag: "textarea", text: "wdyt testing" } },
        { type: "submit", ts: 1030, seq: 3, target: { tag: "form", text: null } },
      ],
    });

    const reviewOutput = await runCli(
      tempDir,
      ["review", "--propose"],
      "a\n",
      {
        WDYT_LLM_BASE_URL: llmUrl,
        WDYT_LLM_API_KEY: "ollama",
        WDYT_LLM_MODEL: "mistral:instruct",
      }
    );

    const reviewFile = await readFile(path.join(tempDir, ".wdyt", "flow-reviews.json"), "utf8");

    assert.ok(capturedRequest);
    assert.match(capturedRequest.messages[0].content, /Step 1 — Extract signals/);
    assert.match(capturedRequest.messages[0].content, /Use registryMatches if clearly relevant/);
    assert.match(capturedRequest.messages[0].content, /approvedVocab contains only canonical terms/);
    assert.match(capturedRequest.messages[1].content, /"registryMatches": \[\n\s+"Google Search"\n\s+\]/);
    assert.match(reviewOutput, /Approved vocab: Google Search/);
    assert.match(reviewOutput, /Proposed vocab: error message, search query/);
    assert.match(
      reviewFile,
      /"proposedDescriptor": "User enters search query 'wdyt testing' and receives an error message on Google Search"/
    );
    assert.match(reviewFile, /"approvedVocabUsed": \[\n\s+"Google Search"\n\s+\]/);
    assert.match(reviewFile, /"proposedVocab": \[\n\s+"error message",\n\s+"search query"\n\s+\]/);
  } finally {
    llmServer.close();
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("review caps confidence for literal typed values even when descriptor is mechanical", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-review-confidence-"));
  const port = randomPort();
  const llmPort = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const llmUrl = `http://127.0.0.1:${llmPort}/v1`;
  const { child } = spawnServer(tempDir, port);
  const requests = [];
  const llmServer = await startMockLlmServer(llmPort, {
    responseContent: {
      descriptor: "User enters search query 'wdyt testing' and clicks submit on Google Search",
      approvedVocab: [],
      proposedVocab: [],
      confidence: 0.62,
      rationale: "The flow includes entering a query and submitting it on Google.",
    },
    onRequest: (body) => {
      requests.push(body);
    },
  });

  try {
    await waitForHealth(serverUrl);

    const started = await postJson(serverUrl, "/runs/start", {
      suiteName: "integration",
      testName: "retry proposal flow",
      environment: { tool: "integration-test" },
    });

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

    await postJson(serverUrl, "/runs/end", {
      runId: started.runId,
      reason: "completed",
    });

    await postJson(serverUrl, "/ingest", {
      suite: bound.suite,
      environment: bound.environment,
      endState: {
        finalUrl: "https://www.google.com/sorry/index",
        title: "Google Search",
        heading: null,
        alertText: "There was an error",
      },
      run: {
        id: started.runId,
        testName: "retry proposal flow",
        startedAt: 0,
        endedAt: 1,
        reason: "completed",
      },
      events: [
        { type: "navigate", ts: 1000, seq: 0, url: "https://www.google.com/ncr" },
        { type: "click", ts: 1010, seq: 1, target: { tag: "textarea", text: "Search" } },
        { type: "input", ts: 1020, seq: 2, target: { tag: "textarea", text: "wdyt testing" } },
        { type: "submit", ts: 1030, seq: 3, target: { tag: "form", text: null } },
      ],
    });

    const reviewOutput = await runCli(
      tempDir,
      ["review", "--propose"],
      "a\n",
      {
        WDYT_LLM_BASE_URL: llmUrl,
        WDYT_LLM_API_KEY: "ollama",
        WDYT_LLM_MODEL: "mistral:instruct",
      }
    );

    const reviewFile = await readFile(path.join(tempDir, ".wdyt", "flow-reviews.json"), "utf8");

    assert.equal(requests.length, 1);
    assert.match(requests[0].messages[0].content, /Else propose new terms \(only if needed\)/);
    assert.match(requests[0].messages[0].content, /proposedVocab:[\s\S]*max 3 items/);
    assert.match(requests[0].messages[0].content, /if vocabulary is empty, briefly explain why evidence is insufficient/);
    assert.match(reviewOutput, /Proposed descriptor: User enters search query 'wdyt testing' and clicks submit on Google Search/);
    assert.match(reviewOutput, /Confidence: 0\.20/);
    assert.match(reviewOutput, /Proposed vocab: -/);
    assert.match(
      reviewFile,
      /"proposedDescriptor": "User enters search query 'wdyt testing' and clicks submit on Google Search"/
    );
    assert.match(reviewFile, /"proposedConfidence": 0\.2/);
  } finally {
    llmServer.close();
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("review raises confidence for explicit successful terminal states", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-review-success-floor-"));
  const port = randomPort();
  const llmPort = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const llmUrl = `http://127.0.0.1:${llmPort}/v1`;
  const { child } = spawnServer(tempDir, port);
  const llmServer = await startMockLlmServer(llmPort, {
    responseContent: {
      descriptor: "Search query is submitted and results are displayed",
      approvedVocab: [],
      proposedVocab: ["search", "search results"],
      confidence: 0.35,
      rationale: "The flow ends on a search results page after the search form is submitted.",
    },
  });

  try {
    await waitForHealth(serverUrl);

    const started = await postJson(serverUrl, "/runs/start", {
      suiteName: "integration",
      testName: "search-results",
      environment: { tool: "integration-test" },
    });

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

    await postJson(serverUrl, "/runs/end", {
      runId: started.runId,
      reason: "completed",
    });

    await postJson(serverUrl, "/ingest", {
      suite: bound.suite,
      environment: bound.environment,
      endState: {
        finalUrl: "http://127.0.0.1:4010/search/results?q=wdyt",
        title: "Search Results",
        heading: "Search Results",
        alertText: null,
      },
      run: {
        id: started.runId,
        testName: "search-results",
        startedAt: 0,
        endedAt: 1,
        reason: "completed",
      },
      events: [
        { type: "navigate", ts: 1000, seq: 0, url: "http://127.0.0.1:4010/login" },
        { type: "input", ts: 1010, seq: 1, target: { tag: "input", text: "demo" } },
        { type: "change", ts: 1020, seq: 2, target: { tag: "input", text: "demo" } },
        { type: "input", ts: 1030, seq: 3, target: { tag: "input", text: "wdyt-demo-2026" } },
        { type: "change", ts: 1040, seq: 4, target: { tag: "input", text: "wdyt-demo-2026" } },
        { type: "click", ts: 1050, seq: 5, target: { tag: "button", text: "Sign in" } },
        { type: "submit", ts: 1060, seq: 6, target: { tag: "form", text: "Username Password Sign in" } },
        { type: "navigate", ts: 1070, seq: 7, url: "http://127.0.0.1:4010/dashboard" },
        { type: "click", ts: 1080, seq: 8, target: { tag: "a", text: "Open search" } },
        { type: "navigate", ts: 1090, seq: 9, url: "http://127.0.0.1:4010/search" },
        { type: "input", ts: 1100, seq: 10, target: { tag: "input", text: "wdyt" } },
        { type: "change", ts: 1110, seq: 11, target: { tag: "input", text: "wdyt" } },
        { type: "click", ts: 1120, seq: 12, target: { tag: "button", text: "Search" } },
        { type: "submit", ts: 1130, seq: 13, target: { tag: "form", text: "Search query Search" } },
        { type: "navigate", ts: 1140, seq: 14, url: "http://127.0.0.1:4010/search/results?q=wdyt" },
      ],
    });

    const reviewOutput = await runCli(
      tempDir,
      ["review", "--propose"],
      "a\n",
      {
        WDYT_LLM_BASE_URL: llmUrl,
        WDYT_LLM_API_KEY: "ollama",
        WDYT_LLM_MODEL: "mistral:instruct",
      }
    );

    const reviewFile = await readFile(path.join(tempDir, ".wdyt", "flow-reviews.json"), "utf8");

    assert.match(reviewOutput, /Confidence: 0\.70/);
    assert.match(reviewFile, /"proposedConfidence": 0\.7/);
  } finally {
    llmServer.close();
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("review keeps deterministic confidence for successful login despite mechanical phrasing", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-review-login-floor-"));
  const port = randomPort();
  const llmPort = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const llmUrl = `http://127.0.0.1:${llmPort}/v1`;
  const { child } = spawnServer(tempDir, port);
  const llmServer = await startMockLlmServer(llmPort, {
    responseContent: {
      descriptor: "Login succeeds and navigates to dashboard",
      approvedVocab: [],
      proposedVocab: ["dashboard", "login", "success"],
      confidence: 0.55,
      rationale: "The flow ends on the dashboard after sign-in with no error alerts.",
    },
  });

  try {
    await waitForHealth(serverUrl);

    const started = await postJson(serverUrl, "/runs/start", {
      suiteName: "integration",
      testName: "login-success-dashboard",
      environment: { tool: "integration-test" },
    });

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

    await postJson(serverUrl, "/runs/end", {
      runId: started.runId,
      reason: "completed",
    });

    await postJson(serverUrl, "/ingest", {
      suite: bound.suite,
      environment: bound.environment,
      endState: {
        finalUrl: "http://127.0.0.1:4010/dashboard",
        title: "Dashboard",
        heading: "Dashboard",
        alertText: null,
      },
      run: {
        id: started.runId,
        testName: "login-success-dashboard",
        startedAt: 0,
        endedAt: 1,
        reason: "completed",
      },
      events: [
        { type: "navigate", ts: 1000, seq: 0, url: "http://127.0.0.1:4010/login" },
        { type: "input", ts: 1010, seq: 1, target: { tag: "input", text: "demo" } },
        { type: "change", ts: 1020, seq: 2, target: { tag: "input", text: "demo" } },
        { type: "input", ts: 1030, seq: 3, target: { tag: "input", text: "wdyt-demo-2026" } },
        { type: "change", ts: 1040, seq: 4, target: { tag: "input", text: "wdyt-demo-2026" } },
        { type: "click", ts: 1050, seq: 5, target: { tag: "button", text: "Sign in" } },
        { type: "submit", ts: 1060, seq: 6, target: { tag: "form", text: "Username Password Sign in" } },
        { type: "navigate", ts: 1070, seq: 7, url: "http://127.0.0.1:4010/dashboard" },
      ],
    });

    const reviewOutput = await runCli(
      tempDir,
      ["review", "--propose"],
      "a\n",
      {
        WDYT_LLM_BASE_URL: llmUrl,
        WDYT_LLM_API_KEY: "ollama",
        WDYT_LLM_MODEL: "mistral:instruct",
      }
    );

    const reviewFile = await readFile(path.join(tempDir, ".wdyt", "flow-reviews.json"), "utf8");

    assert.match(reviewOutput, /Confidence: 0\.70/);
    assert.match(reviewFile, /"proposedConfidence": 0\.7/);
  } finally {
    llmServer.close();
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("review splits one canonical flow into separate outcome variants", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-variants-"));
  const port = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const { child } = spawnServer(tempDir, port);

  try {
    await waitForHealth(serverUrl);

    const startedA = await postJson(serverUrl, "/runs/start", {
      suiteName: "integration",
      testName: "login-success-dashboard",
      environment: { tool: "integration-test" },
    });
    const startedB = await postJson(serverUrl, "/runs/start", {
      suiteName: "integration",
      testName: "login-invalid",
      environment: { tool: "integration-test" },
    });

    await fetch(startedA.bootstrapUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.178 Safari/537.36",
      },
    }).then((response) => response.text());

    const boundA = await postJson(serverUrl, "/bindings/bind", {
      browserSessionId: "browser-session-1",
      runId: startedA.runId,
    });
    const boundB = await postJson(serverUrl, "/bindings/bind", {
      browserSessionId: "browser-session-2",
      runId: startedB.runId,
    });

    const sharedEvents = [
      { type: "navigate", ts: 1000, seq: 0, url: "http://127.0.0.1:4010/login" },
      { type: "input", ts: 1010, seq: 1, target: { tag: "input", text: "demo" } },
      { type: "change", ts: 1020, seq: 2, target: { tag: "input", text: "demo" } },
      { type: "input", ts: 1030, seq: 3, target: { tag: "input", text: "badpass" } },
      { type: "change", ts: 1040, seq: 4, target: { tag: "input", text: "badpass" } },
      { type: "click", ts: 1050, seq: 5, target: { tag: "button", text: "Sign in" } },
      { type: "submit", ts: 1060, seq: 6, target: { tag: "form", text: "Username Password Sign in" } },
      { type: "navigate", ts: 1070, seq: 7, url: "http://127.0.0.1:4010/dashboard" },
    ];

    await postJson(serverUrl, "/ingest", {
      suite: boundA.suite,
      environment: boundA.environment,
      endState: {
        finalUrl: "http://127.0.0.1:4010/dashboard",
        title: "Dashboard",
        heading: "Dashboard",
        alertText: null,
      },
      run: {
        id: startedA.runId,
        testName: "login-success-dashboard",
        startedAt: 0,
        endedAt: 1,
        reason: "completed",
      },
      events: sharedEvents,
    });

    await postJson(serverUrl, "/ingest", {
      suite: boundB.suite,
      environment: boundB.environment,
      endState: {
        finalUrl: "http://127.0.0.1:4010/login",
        title: "Demo Login",
        heading: "Sign in",
        alertText: "Invalid username or password.",
      },
      run: {
        id: startedB.runId,
        testName: "login-invalid",
        startedAt: 0,
        endedAt: 1,
        reason: "completed",
      },
      events: sharedEvents,
    });

    const reviewOutput = await runCli(tempDir, ["review"], "a\na\n");
    assert.match(reviewOutput, /Variant:/);
    assert.match(reviewOutput, /Final URLs:\n\s+- http:\/\/127\.0\.0\.1:4010\/dashboard/);
    assert.match(reviewOutput, /Final URLs:\n\s+- http:\/\/127\.0\.0\.1:4010\/login/);

    const reviewFile = JSON.parse(await readFile(path.join(tempDir, ".wdyt", "flow-reviews.json"), "utf8"));
    assert.equal(reviewFile.length, 2);
    assert.ok(reviewFile.every((record) => typeof record.reviewId === "string"));
    assert.ok(reviewFile.every((record) => typeof record.flowId === "string"));
    assert.ok(reviewFile.every((record) => record.reviewId === record.flowId || record.reviewId.startsWith(`${record.flowId}:`)));
  } finally {
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("review module materializes review units, proposes descriptors, and saves review decisions", { timeout: 20_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-review-ui-"));
  const llmPort = randomPort();
  const llmUrl = `http://127.0.0.1:${llmPort}/v1`;
  const llmServer = await startMockLlmServer(llmPort);
  const originalCwd = process.cwd();
  const originalBaseUrl = process.env.WDYT_LLM_BASE_URL;
  const originalApiKey = process.env.WDYT_LLM_API_KEY;
  const originalModel = process.env.WDYT_LLM_MODEL;

  try {
    process.chdir(tempDir);
    process.env.WDYT_LLM_BASE_URL = llmUrl;
    process.env.WDYT_LLM_API_KEY = "ollama";
    process.env.WDYT_LLM_MODEL = "mistral:instruct";

    const { persistRun } = await import(path.join(repoRoot, "dist", "server", "storage.js"));
    const {
      loadReviewUnits,
      refreshReviewUnits,
      saveReviewUnitEdits,
      requestReviewUnitReprocess,
    } = await import(path.join(repoRoot, "dist", "server", "review.js"));
    const { getVocabularyPath, readJsonFile } = await import(path.join(repoRoot, "dist", "shared", "fs.js"));

    await persistRun({
      suite: {
        id: "integration",
        name: "integration",
        normalizedName: "integration",
      },
      environment: {
        tool: "integration-test",
      },
      endState: {
        finalUrl: "http://127.0.0.1:4010/dashboard",
        title: "Dashboard",
        heading: "Dashboard",
        alertText: null,
      },
      run: {
        id: "run-review-module",
        testName: "ui review flow",
        startedAt: 0,
        endedAt: 1,
        reason: "completed",
      },
      events: [
        { type: "navigate", ts: 1000, seq: 0, url: "http://127.0.0.1:4010/login" },
        { type: "click", ts: 1010, seq: 1, target: { tag: "button", text: "Search" } },
      ],
    });

    await refreshReviewUnits();

    const proposedUnit = await waitForCondition(async () => {
      const units = await loadReviewUnits();
      const first = units[0];
      return first?.proposalState === "proposed" ? first : null;
    });

    assert.equal(proposedUnit.proposedDescriptor, "search ends at dashboard");
    assert.equal(proposedUnit.activeDescriptor, "search ends at dashboard");
    assert.deepEqual(proposedUnit.activeVocab, ["search"]);
    assert.deepEqual(proposedUnit.approvedVocabUsed, []);
    assert.deepEqual(proposedUnit.proposedVocab, ["search"]);

    const updatedUnit = await saveReviewUnitEdits({
      reviewId: proposedUnit.reviewId,
      descriptor: "approved search descriptor",
      notes: "looks good",
      vocab: ["search"],
    });

    assert.equal(updatedUnit.activeDescriptor, "approved search descriptor");
    assert.equal(updatedUnit.interpretationStatus, "edited");
    assert.deepEqual(updatedUnit.activeVocab, ["search"]);
    assert.deepEqual(updatedUnit.approvedVocabUsed, ["search"]);
    assert.deepEqual(updatedUnit.proposedVocab, []);

    const reprocessedUnit = await requestReviewUnitReprocess(proposedUnit.reviewId);
    assert.equal(reprocessedUnit.proposalState, "pending");

    const refreshedUnit = await waitForCondition(async () => {
      const units = await loadReviewUnits();
      const match = units.find((unit) => unit.reviewId === proposedUnit.reviewId);
      return match?.interpretationStatus === "reprocessed" ? match : null;
    });
    assert.equal(refreshedUnit.activeDescriptor, "search ends at dashboard");
    assert.equal(refreshedUnit.interpretationStatus, "reprocessed");

    const vocabulary = await readJsonFile(getVocabularyPath(), []);
    assert.equal(vocabulary[0].term, "search");
    assert.equal(vocabulary[0].status, "approved");
  } finally {
    process.chdir(originalCwd);
    process.env.WDYT_LLM_BASE_URL = originalBaseUrl;
    process.env.WDYT_LLM_API_KEY = originalApiKey;
    process.env.WDYT_LLM_MODEL = originalModel;
    llmServer.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("summary page renders executive overview shell with reordered navigation", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-summary-page-"));
  const port = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const { child } = spawnServer(tempDir, port);

  try {
    await waitForHealth(serverUrl);

    const page = await fetch(`${serverUrl}/review/summary`).then((response) => response.text());
    assert.match(page, /What Did You Test\? \| Summary/);
    assert.match(page, /Executive Overview/);
    assert.match(page, /Critical Flow Coverage/);
    assert.match(page, /Repeated Coverage/);
    assert.match(page, /Unique Flows Observed/);
    assert.match(page, /Covered/);
    assert.match(page, /Partial/);
    assert.match(page, /Missing/);
    assert.match(page, /Unique Flows/);
    assert.match(page, /Review<\/a>\s*<a href="\/critical-flows">Critical Flows<\/a>\s*<a class="active" href="\/review\/summary">Summary<\/a>/);
  } finally {
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("API validation rejects missing required fields and accepts omitted optional metadata", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-validation-"));
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

  assert.match(getOutput(), /WDYT server listening/);
});

test("critical flows cold start saves missing flows and exposes placeholder guidance", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-critical-flows-cold-"));
  const port = randomPort();
  const llmPort = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const llmUrl = `http://127.0.0.1:${llmPort}/v1`;
  const llmServer = await startMockLlmServer(llmPort, {
    responseContent: {
      name: "User can log in and export a report to CSV",
      rawText: "User can log in and export a report to CSV",
      interpretedSteps: ["login", "export report"],
      interpretedTerms: ["login", "export report", "csv"],
      outcome: "report exported",
    },
  });
  const { child } = spawnServer(tempDir, port, {
    WDYT_LLM_BASE_URL: llmUrl,
    WDYT_LLM_API_KEY: "ollama",
    WDYT_LLM_MODEL: "mistral:instruct",
  });

  try {
    await waitForHealth(serverUrl);

    const page = await fetch(`${serverUrl}/critical-flows`).then((response) => response.text());
    assert.match(page, /Critical Flows/);
    assert.match(page, /What are the most important things your application must do\?/);
    assert.match(page, /Learn how to capture a test/);

    const interpreted = await postJson(serverUrl, "/critical-flows/interpret", {
      rawText: "User can log in and export a report to CSV",
    });
    assert.deepEqual(interpreted.interpretedSteps, ["login", "export report"]);
    assert.deepEqual(interpreted.interpretedTerms, ["csv", "export report", "login"]);
    assert.equal(interpreted.outcome, "report exported");

    const created = await postJson(serverUrl, "/critical-flows", interpreted);
    assert.equal(created.status, "missing");
    assert.deepEqual(created.matchedDescriptorIds, []);

    const state = await getJson(serverUrl, "/critical-flows/state");
    assert.equal(state.hasDescriptors ?? state.hasApprovedDescriptors, false);
    assert.equal(state.flows.length, 1);
    assert.equal(state.flows[0].status, "missing");

    const captureGuide = await fetch(`${serverUrl}/critical-flows/capture-guide`).then((response) => response.text());
    assert.match(captureGuide, /TODO: Add product-specific guidance/);
  } finally {
    llmServer.close();
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("critical flows suggest active descriptors and match composite coverage", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-critical-flows-covered-"));
  const port = randomPort();
  const llmPort = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const llmUrl = `http://127.0.0.1:${llmPort}/v1`;
  const dataDir = path.join(tempDir, ".wdyt");
  const llmServer = await startMockLlmServer(llmPort, {
    responseContent: {
      name: "User can log in and create and export a report",
      rawText: "User can log in and create and export a report",
      interpretedSteps: ["login", "create report", "export report"],
      interpretedTerms: ["login", "create report", "export report"],
      outcome: "report exported",
    },
  });

  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, "review-units.json"),
    `${JSON.stringify(
      [
        {
          reviewId: "descriptor-login",
          flowId: "descriptor-login",
          canonical: ["NAVIGATE"],
          count: 1,
          suites: ["integration"],
          tests: ["login-success"],
          tools: ["integration-test"],
          browsers: ["chromium 146"],
          urls: [],
          targets: [],
          finalUrls: [],
          titles: [],
          headings: [],
          alerts: [],
          proposalState: "proposed",
          proposedDescriptor: "Successful sign-in",
          proposedConfidence: 0.8,
          proposedRationale: "Login succeeds.",
          approvedVocabUsed: ["login"],
          proposedVocab: [],
          reviewStatus: "approved",
          approvedDescriptor: "Successful sign-in",
          updatedAt: 1,
        },
        {
          reviewId: "descriptor-create-report",
          flowId: "descriptor-create-report",
          canonical: ["NAVIGATE"],
          count: 1,
          suites: ["integration"],
          tests: ["create-report"],
          tools: ["integration-test"],
          browsers: ["chromium 146"],
          urls: [],
          targets: [],
          finalUrls: [],
          titles: [],
          headings: [],
          alerts: [],
          proposalState: "proposed",
          proposedDescriptor: "Create report",
          proposedConfidence: 0.8,
          proposedRationale: "Report is created.",
          approvedVocabUsed: ["create report"],
          proposedVocab: [],
          reviewStatus: "approved",
          approvedDescriptor: "Create report",
          updatedAt: 1,
        },
        {
          reviewId: "descriptor-export-report",
          flowId: "descriptor-export-report",
          canonical: ["NAVIGATE"],
          count: 1,
          suites: ["integration"],
          tests: ["export-report"],
          tools: ["integration-test"],
          browsers: ["chromium 146"],
          urls: [],
          targets: [],
          finalUrls: [],
          titles: [],
          headings: [],
          alerts: [],
          proposalState: "proposed",
          proposedDescriptor: "Export report",
          proposedConfidence: 0.8,
          proposedRationale: "Report is exported.",
          approvedVocabUsed: ["export report"],
          proposedVocab: [],
          reviewStatus: "approved",
          approvedDescriptor: "Export report",
          updatedAt: 1,
        },
      ],
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(dataDir, "runs.processed.jsonl"),
    [
      {
        runId: "run-login",
        suite: { id: "integration", name: "integration", normalizedName: "integration" },
        environment: { tool: "integration-test" },
        endState: {},
        reduced: ["NAVIGATE"],
        canonical: ["NAVIGATE"],
        flowId: "descriptor-login",
        meta: { canonicalSource: "reducer" },
      },
      {
        runId: "run-create-report",
        suite: { id: "integration", name: "integration", normalizedName: "integration" },
        environment: { tool: "integration-test" },
        endState: {},
        reduced: ["NAVIGATE"],
        canonical: ["NAVIGATE"],
        flowId: "descriptor-create-report",
        meta: { canonicalSource: "reducer" },
      },
      {
        runId: "run-export-report",
        suite: { id: "integration", name: "integration", normalizedName: "integration" },
        environment: { tool: "integration-test" },
        endState: {},
        reduced: ["NAVIGATE"],
        canonical: ["NAVIGATE"],
        flowId: "descriptor-export-report",
        meta: { canonicalSource: "reducer" },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(dataDir, "runs.raw.jsonl"),
    [
      {
        suite: { id: "integration", name: "integration", normalizedName: "integration" },
        environment: { tool: "integration-test" },
        endState: {},
        run: { id: "run-login", testName: "login-success", startedAt: 0, endedAt: 1, reason: "completed" },
        events: [{ type: "navigate", ts: 1000, seq: 0, url: "http://127.0.0.1:4010/login" }],
      },
      {
        suite: { id: "integration", name: "integration", normalizedName: "integration" },
        environment: { tool: "integration-test" },
        endState: {},
        run: { id: "run-create-report", testName: "create-report", startedAt: 0, endedAt: 1, reason: "completed" },
        events: [{ type: "navigate", ts: 1000, seq: 0, url: "http://127.0.0.1:4010/reports" }],
      },
      {
        suite: { id: "integration", name: "integration", normalizedName: "integration" },
        environment: { tool: "integration-test" },
        endState: {},
        run: { id: "run-export-report", testName: "export-report", startedAt: 0, endedAt: 1, reason: "completed" },
        events: [{ type: "navigate", ts: 1000, seq: 0, url: "http://127.0.0.1:4010/reports/export" }],
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    "utf8"
  );

  const { child } = spawnServer(tempDir, port, {
    WDYT_LLM_BASE_URL: llmUrl,
    WDYT_LLM_API_KEY: "ollama",
    WDYT_LLM_MODEL: "mistral:instruct",
  });

  try {
    await waitForHealth(serverUrl);

    const initialState = await getJson(serverUrl, "/critical-flows/state");
    assert.equal(initialState.hasDescriptors ?? initialState.hasApprovedDescriptors, true);
    assert.deepEqual(initialState.suggestions, [
      "Create a report",
      "Export a report to CSV",
      "Sign in successfully",
    ]);

    const interpreted = await postJson(serverUrl, "/critical-flows/interpret", {
      rawText: "User can log in and create and export a report",
    });
    const created = await postJson(serverUrl, "/critical-flows", interpreted);

    assert.equal(created.status, "covered");
    assert.deepEqual(created.matchedDescriptorIds.sort(), [
      "descriptor-create-report",
      "descriptor-export-report",
      "descriptor-login",
    ]);

    const state = await getJson(serverUrl, "/critical-flows/state");
    assert.equal(state.flows.length, 1);
    assert.equal(state.flows[0].status, "covered");
    assert.deepEqual(state.flows[0].matchedConcepts, ["create report", "export report", "login"]);
    assert.deepEqual(state.flows[0].missingTerms, []);
    assert.deepEqual(state.suggestions, []);
    assert.deepEqual(
      state.flows[0].matchedDescriptors.map((descriptor) => descriptor.name).sort(),
      ["Create report", "Export report", "Successful sign-in"]
    );
  } finally {
    llmServer.close();
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("critical flows frame missing terms as missing reviewed evidence", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-critical-flows-partial-"));
  const port = randomPort();
  const llmPort = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const llmUrl = `http://127.0.0.1:${llmPort}/v1`;
  const dataDir = path.join(tempDir, ".wdyt");
  const llmServer = await startMockLlmServer(llmPort, {
    responseContent: {
      name: "User can log in and create and export a report",
      rawText: "User can log in and create and export a report",
      interpretedSteps: ["login", "create report", "export report"],
      interpretedTerms: ["login", "create report", "export report"],
      outcome: "report exported",
    },
  });

  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, "review-units.json"),
    `${JSON.stringify(
      [
        {
          reviewId: "descriptor-login",
          flowId: "descriptor-login",
          canonical: ["NAVIGATE"],
          count: 1,
          suites: ["integration"],
          tests: ["login-success"],
          tools: ["integration-test"],
          browsers: ["chromium 146"],
          urls: [],
          targets: [],
          finalUrls: [],
          titles: [],
          headings: [],
          alerts: [],
          proposalState: "proposed",
          proposedDescriptor: "Successful sign-in",
          proposedConfidence: 0.8,
          proposedRationale: "Login succeeds.",
          approvedVocabUsed: ["login"],
          proposedVocab: [],
          reviewStatus: "approved",
          approvedDescriptor: "Successful sign-in",
          updatedAt: 1,
        },
        {
          reviewId: "descriptor-create-report",
          flowId: "descriptor-create-report",
          canonical: ["NAVIGATE"],
          count: 1,
          suites: ["integration"],
          tests: ["create-report"],
          tools: ["integration-test"],
          browsers: ["chromium 146"],
          urls: [],
          targets: [],
          finalUrls: [],
          titles: [],
          headings: [],
          alerts: [],
          proposalState: "proposed",
          proposedDescriptor: "Create report",
          proposedConfidence: 0.8,
          proposedRationale: "Report is created.",
          approvedVocabUsed: ["create report"],
          proposedVocab: [],
          reviewStatus: "approved",
          approvedDescriptor: "Create report",
          updatedAt: 1,
        },
      ],
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(dataDir, "runs.processed.jsonl"),
    [
      {
        runId: "run-login",
        suite: { id: "integration", name: "integration", normalizedName: "integration" },
        environment: { tool: "integration-test" },
        endState: {},
        reduced: ["NAVIGATE"],
        canonical: ["NAVIGATE"],
        flowId: "descriptor-login",
        meta: { canonicalSource: "reducer" },
      },
      {
        runId: "run-create-report",
        suite: { id: "integration", name: "integration", normalizedName: "integration" },
        environment: { tool: "integration-test" },
        endState: {},
        reduced: ["NAVIGATE"],
        canonical: ["NAVIGATE"],
        flowId: "descriptor-create-report",
        meta: { canonicalSource: "reducer" },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(dataDir, "runs.raw.jsonl"),
    [
      {
        suite: { id: "integration", name: "integration", normalizedName: "integration" },
        environment: { tool: "integration-test" },
        endState: {},
        run: { id: "run-login", testName: "login-success", startedAt: 0, endedAt: 1, reason: "completed" },
        events: [{ type: "navigate", ts: 1000, seq: 0, url: "http://127.0.0.1:4010/login" }],
      },
      {
        suite: { id: "integration", name: "integration", normalizedName: "integration" },
        environment: { tool: "integration-test" },
        endState: {},
        run: { id: "run-create-report", testName: "create-report", startedAt: 0, endedAt: 1, reason: "completed" },
        events: [{ type: "navigate", ts: 1000, seq: 0, url: "http://127.0.0.1:4010/reports" }],
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    "utf8"
  );

  const { child } = spawnServer(tempDir, port, {
    WDYT_LLM_BASE_URL: llmUrl,
    WDYT_LLM_API_KEY: "ollama",
    WDYT_LLM_MODEL: "mistral:instruct",
  });

  try {
    await waitForHealth(serverUrl);

    const interpreted = await postJson(serverUrl, "/critical-flows/interpret", {
      rawText: "User can log in and create and export a report",
    });
    const created = await postJson(serverUrl, "/critical-flows", interpreted);
    assert.equal(created.status, "partial");

    const state = await getJson(serverUrl, "/critical-flows/state");
    assert.equal(state.flows[0].status, "partial");
    assert.deepEqual(state.flows[0].matchedConcepts, ["create report", "login"]);
    assert.deepEqual(state.flows[0].missingTerms, ["export report"]);

    const page = await fetch(`${serverUrl}/critical-flows`).then((response) => response.text());
    assert.match(page, /Coverage Gaps/);
    assert.match(page, /Missing:/);
    assert.match(page, /Missing in/);
    assert.match(page, /Potential missing coverage/);
    assert.match(page, /No reviewed test evidence currently matches:/);
    assert.match(page, /No reviewed test evidence matches this critical flow yet\./);
    assert.match(
      page,
      /These concepts were not found in reviewed descriptor vocabulary\. This may indicate missing test coverage, missing reviewed runs, or vocabulary mismatch\./
    );
  } finally {
    llmServer.close();
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("critical flows normalize search plus results into covered search results", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-critical-flows-search-results-"));
  const dataDir = path.join(tempDir, ".wdyt");
  const originalCwd = process.cwd();

  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(dataDir, "review-units.json"),
      `${JSON.stringify(
        [
          {
            reviewId: "descriptor-search-results",
            flowId: "descriptor-search-results",
            canonical: ["NAVIGATE"],
            count: 1,
            suites: ["integration"],
            tests: ["search-results"],
            tools: ["integration-test"],
            browsers: ["chromium 146"],
            urls: [],
            targets: [],
            finalUrls: [],
            titles: [],
            headings: [],
            alerts: [],
            proposalState: "proposed",
            proposedDescriptor: "Search query is submitted and results are displayed",
            proposedConfidence: 0.8,
            proposedRationale: "Search results are displayed.",
            approvedVocabUsed: [],
            proposedVocab: ["search", "search results"],
            activeDescriptor: "Search query is submitted and results are displayed",
            activeVocab: ["search", "search results"],
            interpretationStatus: "auto-generated",
            updatedAt: 1,
          },
        ],
        null,
        2
      )}\n`,
      "utf8"
    );

    process.chdir(tempDir);
    const { createCriticalFlow, loadCriticalFlowState } = await import(path.join(repoRoot, "dist", "server", "critical-flows.js"));

    const created = await createCriticalFlow({
      name: "Search and display results",
      rawText: "Search queries are submitted with results displayed",
      interpretedSteps: ["search", "view results"],
      interpretedTerms: ["results", "search"],
      outcome: "results visible",
    });

    assert.equal(created.status, "covered");
    assert.deepEqual(created.interpretedTerms, ["search", "search results"]);
    assert.deepEqual(created.matchedDescriptorIds, ["descriptor-search-results"]);

    const state = await loadCriticalFlowState();
    assert.deepEqual(state.flows[0].missingTerms, []);
  } finally {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("critical flows can be updated and deleted", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-critical-flows-edit-delete-"));
  const port = randomPort();
  const llmPort = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const llmUrl = `http://127.0.0.1:${llmPort}/v1`;
  const dataDir = path.join(tempDir, ".wdyt");
  const llmServer = await startMockLlmServer(llmPort, {
    responseContent: {
      name: "Create a report",
      rawText: "Create a report",
      interpretedSteps: ["create report"],
      interpretedTerms: ["create report"],
      outcome: "report created",
    },
  });

  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, "review-units.json"),
    `${JSON.stringify(
      [
        {
          reviewId: "descriptor-create-report",
          flowId: "descriptor-create-report",
          canonical: ["NAVIGATE"],
          count: 1,
          suites: ["integration"],
          tests: ["create-report"],
          tools: ["integration-test"],
          browsers: ["chromium 146"],
          urls: [],
          targets: [],
          finalUrls: [],
          titles: [],
          headings: [],
          alerts: [],
          proposalState: "proposed",
          proposedDescriptor: "Create report",
          proposedConfidence: 0.8,
          proposedRationale: "Report is created.",
          approvedVocabUsed: ["create report"],
          proposedVocab: [],
          reviewStatus: "approved",
          approvedDescriptor: "Create report",
          updatedAt: 1,
        },
      ],
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(dataDir, "runs.processed.jsonl"),
    [
      {
        runId: "run-create-report",
        suite: { id: "integration", name: "integration", normalizedName: "integration" },
        environment: { tool: "integration-test" },
        endState: {},
        reduced: ["NAVIGATE"],
        canonical: ["NAVIGATE"],
        flowId: "descriptor-create-report",
        meta: { canonicalSource: "reducer" },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(dataDir, "runs.raw.jsonl"),
    [
      {
        suite: { id: "integration", name: "integration", normalizedName: "integration" },
        environment: { tool: "integration-test" },
        endState: {},
        run: { id: "run-create-report", testName: "create-report", startedAt: 0, endedAt: 1, reason: "completed" },
        events: [{ type: "navigate", ts: 1000, seq: 0, url: "http://127.0.0.1:4010/reports" }],
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    "utf8"
  );

  const { child } = spawnServer(tempDir, port, {
    WDYT_LLM_BASE_URL: llmUrl,
    WDYT_LLM_API_KEY: "ollama",
    WDYT_LLM_MODEL: "mistral:instruct",
  });

  try {
    await waitForHealth(serverUrl);

    const created = await postJson(serverUrl, "/critical-flows", {
      name: "Create a report",
      rawText: "Create a report",
      interpretedSteps: ["create report"],
      interpretedTerms: ["create report"],
      outcome: "report created",
    });
    assert.equal(created.status, "covered");

    const updated = await fetch(`${serverUrl}/critical-flows/${encodeURIComponent(created.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Create and export a report",
        rawText: "Create and export a report",
        interpretedSteps: ["create report", "export report"],
        interpretedTerms: ["create report", "export report"],
        outcome: "report exported",
      }),
    }).then((response) => response.json());

    assert.equal(updated.name, "Create and export a report");
    assert.equal(updated.status, "partial");

    const stateAfterUpdate = await getJson(serverUrl, "/critical-flows/state");
    assert.equal(stateAfterUpdate.flows.length, 1);
    assert.equal(stateAfterUpdate.flows[0].status, "partial");
    assert.deepEqual(stateAfterUpdate.flows[0].missingTerms, ["export report"]);

    const deleted = await fetch(`${serverUrl}/critical-flows/${encodeURIComponent(created.id)}`, {
      method: "DELETE",
    }).then((response) => response.json());
    assert.equal(deleted.ok, true);

    const stateAfterDelete = await getJson(serverUrl, "/critical-flows/state");
    assert.equal(stateAfterDelete.flows.length, 0);
  } finally {
    llmServer.close();
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("review page surfaces repeated coverage for proposed review units with matching vocab sets", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-review-overlap-"));
  const port = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const dataDir = path.join(tempDir, ".wdyt");

  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, "review-units.json"),
    `${JSON.stringify(
      [
        {
          reviewId: "sample-login-dashboard-1",
          flowId: "sample-login-dashboard-1",
          canonical: ["NAVIGATE"],
          count: 1,
          suites: ["examples/demo/sample"],
          tests: ["sample-login-dashboard-1"],
          tools: ["demo"],
          browsers: ["chromium sample"],
          urls: [],
          targets: [],
          finalUrls: [],
          titles: [],
          headings: [],
          alerts: [],
          proposalState: "proposed",
          proposedDescriptor: "Successful login leads to dashboard",
          proposedConfidence: 0.82,
          proposedRationale: "Sample reviewed flow for overlap grouping.",
          approvedVocabUsed: ["login", "dashboard"],
          proposedVocab: [],
          reviewStatus: "pending",
          updatedAt: 1,
        },
        {
          reviewId: "sample-login-dashboard-2",
          flowId: "sample-login-dashboard-2",
          canonical: ["NAVIGATE"],
          count: 1,
          suites: ["examples/demo/sample"],
          tests: ["sample-login-dashboard-2"],
          tools: ["demo"],
          browsers: ["chromium sample"],
          urls: [],
          targets: [],
          finalUrls: [],
          titles: [],
          headings: [],
          alerts: [],
          proposalState: "proposed",
          proposedDescriptor: "User signs in and reaches dashboard",
          proposedConfidence: 0.82,
          proposedRationale: "Sample reviewed flow for overlap grouping.",
          approvedVocabUsed: ["login", "dashboard"],
          proposedVocab: [],
          reviewStatus: "pending",
          updatedAt: 1,
        },
        {
          reviewId: "sample-login-dashboard-3",
          flowId: "sample-login-dashboard-3",
          canonical: ["NAVIGATE"],
          count: 1,
          suites: ["examples/demo/sample"],
          tests: ["sample-login-dashboard-3"],
          tools: ["demo"],
          browsers: ["chromium sample"],
          urls: [],
          targets: [],
          finalUrls: [],
          titles: [],
          headings: [],
          alerts: [],
          proposalState: "proposed",
          proposedDescriptor: "Dashboard is displayed after login",
          proposedConfidence: 0.82,
          proposedRationale: "Sample reviewed flow for overlap grouping.",
          approvedVocabUsed: ["login", "dashboard"],
          proposedVocab: [],
          reviewStatus: "pending",
          updatedAt: 1,
        },
        {
          reviewId: "sample-create-report-1",
          flowId: "sample-create-report-1",
          canonical: ["NAVIGATE"],
          count: 1,
          suites: ["examples/demo/sample"],
          tests: ["sample-create-report-1"],
          tools: ["demo"],
          browsers: ["chromium sample"],
          urls: [],
          targets: [],
          finalUrls: [],
          titles: [],
          headings: [],
          alerts: [],
          proposalState: "proposed",
          proposedDescriptor: "User creates a report",
          proposedConfidence: 0.8,
          proposedRationale: "Sample reviewed flow for overlap grouping.",
          approvedVocabUsed: ["create report"],
          proposedVocab: [],
          reviewStatus: "pending",
          updatedAt: 1,
        },
        {
          reviewId: "sample-create-report-2",
          flowId: "sample-create-report-2",
          canonical: ["NAVIGATE"],
          count: 1,
          suites: ["examples/demo/sample"],
          tests: ["sample-create-report-2"],
          tools: ["demo"],
          browsers: ["chromium sample"],
          urls: [],
          targets: [],
          finalUrls: [],
          titles: [],
          headings: [],
          alerts: [],
          proposalState: "proposed",
          proposedDescriptor: "New report is successfully created",
          proposedConfidence: 0.8,
          proposedRationale: "Sample reviewed flow for overlap grouping.",
          approvedVocabUsed: ["create report"],
          proposedVocab: [],
          reviewStatus: "pending",
          updatedAt: 1,
        },
      ],
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(dataDir, "runs.processed.jsonl"),
    [
      "sample-login-dashboard-1",
      "sample-login-dashboard-2",
      "sample-login-dashboard-3",
      "sample-create-report-1",
      "sample-create-report-2",
    ]
      .map((flowId) =>
        JSON.stringify({
          runId: `run-${flowId}`,
          suite: { id: "examples-demo-sample", name: "examples/demo/sample", normalizedName: "examples-demo-sample" },
          environment: { tool: "demo" },
          endState: {},
          reduced: ["NAVIGATE"],
          canonical: ["NAVIGATE"],
          flowId,
          meta: { canonicalSource: "reducer" },
        })
      )
      .join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(dataDir, "runs.raw.jsonl"),
    [
      "sample-login-dashboard-1",
      "sample-login-dashboard-2",
      "sample-login-dashboard-3",
      "sample-create-report-1",
      "sample-create-report-2",
    ]
      .map((flowId) =>
        JSON.stringify({
          suite: { id: "examples-demo-sample", name: "examples/demo/sample", normalizedName: "examples-demo-sample" },
          environment: { tool: "demo" },
          endState: {},
          run: { id: `run-${flowId}`, testName: flowId, startedAt: 0, endedAt: 1, reason: "completed" },
          events: [{ type: "navigate", ts: 1000, seq: 0, url: "http://127.0.0.1:4010/demo" }],
        })
      )
      .join("\n") + "\n",
    "utf8"
  );

  const { child } = spawnServer(tempDir, port);

  try {
    await waitForHealth(serverUrl);

    const reviewPage = await fetch(`${serverUrl}/review`).then((response) => response.text());
    assert.match(reviewPage, /Repeated Coverage/);
    assert.match(reviewPage, /Appears in/);
    assert.doesNotMatch(reviewPage, /reviewed flows/);

    const units = await getJson(serverUrl, "/review/units");
    assert.equal(units.length, 5);
  } finally {
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("review page groups semantically similar repeated coverage with divergent active vocab", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-review-semantic-overlap-"));
  const port = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const dataDir = path.join(tempDir, ".wdyt");

  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, "review-units.json"),
    `${JSON.stringify(
      [
        {
          reviewId: "dashboard-a",
          flowId: "dashboard-a",
          canonical: ["NAVIGATE"],
          count: 1,
          suites: ["examples/demo/sample"],
          tests: ["login-success-dashboard"],
          tools: ["demo"],
          browsers: ["chromium sample"],
          urls: [],
          targets: [],
          finalUrls: [],
          titles: [],
          headings: [],
          alerts: [],
          proposalState: "proposed",
          proposedDescriptor: "Login succeeds and navigates to dashboard",
          proposedConfidence: 0.8,
          proposedRationale: "Sample semantic overlap case.",
          approvedVocabUsed: [],
          proposedVocab: ["dashboard", "login", "success"],
          activeDescriptor: "Login succeeds and navigates to dashboard",
          activeVocab: ["dashboard", "login", "success"],
          updatedAt: 1,
        },
        {
          reviewId: "dashboard-b",
          flowId: "dashboard-b",
          canonical: ["NAVIGATE"],
          count: 1,
          suites: ["examples/demo/sample"],
          tests: ["dashboard-link-after-login"],
          tools: ["demo"],
          browsers: ["chromium sample"],
          urls: [],
          targets: [],
          finalUrls: [],
          titles: [],
          headings: [],
          alerts: [],
          proposalState: "proposed",
          proposedDescriptor: "Login succeeds and navigates to dashboard",
          proposedConfidence: 0.8,
          proposedRationale: "Sample semantic overlap case.",
          approvedVocabUsed: [],
          proposedVocab: ["dashboard", "login", "successful login"],
          activeDescriptor: "Login succeeds and navigates to dashboard",
          activeVocab: ["dashboard", "login", "successful login"],
          updatedAt: 1,
        },
        {
          reviewId: "dashboard-c",
          flowId: "dashboard-c",
          canonical: ["NAVIGATE"],
          count: 1,
          suites: ["examples/demo/sample"],
          tests: ["login-redirect-dashboard"],
          tools: ["demo"],
          browsers: ["chromium sample"],
          urls: [],
          targets: [],
          finalUrls: [],
          titles: [],
          headings: [],
          alerts: [],
          proposalState: "proposed",
          proposedDescriptor: "Login succeeds and redirects to dashboard",
          proposedConfidence: 0.8,
          proposedRationale: "Sample semantic overlap case.",
          approvedVocabUsed: [],
          proposedVocab: ["dashboard", "login", "successful authentication"],
          activeDescriptor: "Login succeeds and redirects to dashboard",
          activeVocab: ["dashboard", "login", "successful authentication"],
          updatedAt: 1,
        },
        {
          reviewId: "search-a",
          flowId: "search-a",
          canonical: ["NAVIGATE"],
          count: 1,
          suites: ["examples/demo/sample"],
          tests: ["search-results"],
          tools: ["demo"],
          browsers: ["chromium sample"],
          urls: [],
          targets: [],
          finalUrls: [],
          titles: [],
          headings: [],
          alerts: [],
          proposalState: "proposed",
          proposedDescriptor: "Search is submitted and results are displayed",
          proposedConfidence: 0.8,
          proposedRationale: "Sample semantic overlap case.",
          approvedVocabUsed: [],
          proposedVocab: ["search", "search results"],
          activeDescriptor: "Search is submitted and results are displayed",
          activeVocab: ["search", "search results"],
          updatedAt: 1,
        },
        {
          reviewId: "search-b",
          flowId: "search-b",
          canonical: ["NAVIGATE"],
          count: 1,
          suites: ["examples/demo/sample"],
          tests: ["search-results-repeat"],
          tools: ["demo"],
          browsers: ["chromium sample"],
          urls: [],
          targets: [],
          finalUrls: [],
          titles: [],
          headings: [],
          alerts: [],
          proposalState: "proposed",
          proposedDescriptor: "Search is performed with repeated queries ending on results",
          proposedConfidence: 0.8,
          proposedRationale: "Sample semantic overlap case.",
          approvedVocabUsed: [],
          proposedVocab: ["query repetition", "search", "search results"],
          activeDescriptor: "Search is performed with repeated queries ending on results",
          activeVocab: ["query repetition", "search", "search results"],
          updatedAt: 1,
        },
      ],
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(dataDir, "runs.processed.jsonl"),
    [
      "dashboard-a",
      "dashboard-b",
      "dashboard-c",
      "search-a",
      "search-b",
    ]
      .map((flowId) =>
        JSON.stringify({
          runId: `run-${flowId}`,
          suite: { id: "examples-demo-sample", name: "examples/demo/sample", normalizedName: "examples-demo-sample" },
          environment: { tool: "demo" },
          endState: {},
          reduced: ["NAVIGATE"],
          canonical: ["NAVIGATE"],
          flowId,
          meta: { canonicalSource: "reducer" },
        })
      )
      .join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(dataDir, "runs.raw.jsonl"),
    [
      ["dashboard-a", "login-success-dashboard"],
      ["dashboard-b", "dashboard-link-after-login"],
      ["dashboard-c", "login-redirect-dashboard"],
      ["search-a", "search-results"],
      ["search-b", "search-results-repeat"],
    ]
      .map(([flowId, testName]) =>
        JSON.stringify({
          suite: { id: "examples-demo-sample", name: "examples/demo/sample", normalizedName: "examples-demo-sample" },
          environment: { tool: "demo" },
          endState: {},
          run: { id: `run-${flowId}`, testName, startedAt: 0, endedAt: 1, reason: "completed" },
          events: [{ type: "navigate", ts: 1000, seq: 0, url: "http://127.0.0.1:4010/demo" }],
        })
      )
      .join("\n") + "\n",
    "utf8"
  );

  const { child } = spawnServer(tempDir, port);

  try {
    await waitForHealth(serverUrl);

    const reviewPage = await fetch(`${serverUrl}/review`).then((response) => response.text());
    assert.match(reviewPage, /Repeated Coverage/);

    const units = await getJson(serverUrl, "/review/units");
    const dashboardUnits = units.filter((unit) =>
      ["login-success-dashboard", "dashboard-link-after-login", "login-redirect-dashboard"].some((testName) =>
        (unit.tests || []).includes(testName)
      )
    );
    const searchUnits = units.filter((unit) =>
      ["search-results", "search-results-repeat"].some((testName) => (unit.tests || []).includes(testName))
    );
    assert.equal(dashboardUnits.length, 3);
    assert.equal(searchUnits.length, 2);
    assert.deepEqual(
      dashboardUnits.map((unit) => unit.overlapTerms),
      [
        ["dashboard", "login"],
        ["dashboard", "login"],
        ["dashboard", "login"],
      ]
    );
    assert.deepEqual(
      searchUnits.map((unit) => unit.overlapTerms),
      [
        ["search", "search results"],
        ["query repetition", "search", "search results"],
      ]
    );
  } finally {
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});
