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

test("review downweights confidence when validator flags literal input and step narration", { timeout: 15_000 }, async () => {
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
    assert.match(reviewOutput, /Confidence: 0\.05/);
    assert.match(reviewOutput, /Proposed vocab: -/);
    assert.match(
      reviewFile,
      /"proposedDescriptor": "User enters search query 'wdyt testing' and clicks submit on Google Search"/
    );
    assert.match(reviewFile, /"proposedConfidence": 0\.05/);
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

test("server materializes review units, proposes descriptors in background, and saves review decisions", { timeout: 20_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-review-ui-"));
  const port = randomPort();
  const llmPort = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const llmUrl = `http://127.0.0.1:${llmPort}/v1`;
  const llmServer = await startMockLlmServer(llmPort);
  const { child } = spawnServer(tempDir, port, {
    WDYT_LLM_BASE_URL: llmUrl,
    WDYT_LLM_API_KEY: "ollama",
    WDYT_LLM_MODEL: "mistral:instruct",
  });

  try {
    await waitForHealth(serverUrl);

    const started = await postJson(serverUrl, "/runs/start", {
      suiteName: "integration",
      testName: "ui review flow",
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

    const proposedUnit = await waitForCondition(async () => {
      const units = await getJson(serverUrl, "/review/units");
      const first = units[0];
      return first?.proposalState === "proposed" ? first : null;
    });

    assert.equal(proposedUnit.proposedDescriptor, "search ends at dashboard");
    assert.deepEqual(proposedUnit.approvedVocabUsed, []);
    assert.deepEqual(proposedUnit.proposedVocab, ["search"]);

    const reviewPage = await fetch(`${serverUrl}/review`).then((response) => response.text());
    assert.match(reviewPage, /What Did You Test\? \| Review/);
    assert.match(reviewPage, /overflow-wrap: anywhere;/);
    assert.match(reviewPage, /word-break: break-word;/);

    const updatedUnit = await postJson(serverUrl, `/review/units/${encodeURIComponent(proposedUnit.reviewId)}`, {
      reviewStatus: "approved",
      approvedDescriptor: "approved search descriptor",
      notes: "looks good",
      promoteVocab: ["search"],
    });

    assert.equal(updatedUnit.reviewStatus, "approved");
    assert.equal(updatedUnit.approvedDescriptor, "approved search descriptor");
    assert.deepEqual(updatedUnit.approvedVocabUsed, ["search"]);
    assert.deepEqual(updatedUnit.proposedVocab, []);

    const vocabulary = await getJson(serverUrl, "/review/vocabulary");
    assert.equal(vocabulary[0].term, "search");
    assert.equal(vocabulary[0].status, "approved");
  } finally {
    llmServer.close();
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
