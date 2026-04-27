import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

async function waitForHealth(serverUrl, timeoutMs = 15_000) {
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

const TEST_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.178 Safari/537.36";

function buildBootstrapUrl(serverUrl, params) {
  const url = new URL("/bootstrap", serverUrl);
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.length > 0) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

async function fetchBootstrap(serverUrl, params, userAgent = TEST_USER_AGENT) {
  const response = await fetch(buildBootstrapUrl(serverUrl, params), {
    headers: {
      "user-agent": userAgent,
    },
  });
  return response.text();
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

async function readZipEntries(zipPath) {
  const buffer = Buffer.isBuffer(zipPath) ? zipPath : await readFile(zipPath);
  const entries = new Map();
  let offset = 0;

  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      break;
    }

    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const fileName = buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf8");

    assert.equal(compressionMethod, 0);
    entries.set(fileName, buffer.subarray(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }

  return entries;
}

async function startMockLlmServer(port, options = {}) {
  const evidenceResponseContent = options.evidenceResponseContent ?? { items: [] };
  const conceptResponseContent = options.conceptResponseContent ?? { concepts: [] };
  const roleResponseContent = options.roleResponseContent ?? {
    termRoles: [
      { term: "search", role: "primary" },
    ],
  };
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
        const systemPrompt = String(parsedBody?.messages?.[0]?.content ?? "");
        const nextContent = responseSequence.shift() ?? (
          systemPrompt.includes("label each provided evidence item with one bucket")
            ? evidenceResponseContent
            : systemPrompt.includes("group classified evidence items into reusable semantic concepts")
              ? conceptResponseContent
              : systemPrompt.includes("assign each provided flow term one role")
            ? roleResponseContent
            : responseContent
        );
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

test("vocab stats count all review units and prerequisite analysis suppresses repeated login/setup terms", async () => {
  const { collectVocabStats, analyzePrerequisites } = await import(path.join(repoRoot, "dist", "shared", "flow-suppression.js"));

  const stats = collectVocabStats(
    [
      {
        activeDescriptor: "Login and export report",
        proposedDescriptor: "Login and export report",
        activeVocab: ["login", "workspace", "export report"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
      {
        activeDescriptor: "Login and create report",
        proposedDescriptor: "Login and create report",
        activeVocab: ["login", "workspace", "create report"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
      {
        activeDescriptor: "Login and view dashboard",
        proposedDescriptor: "Login and view dashboard",
        activeVocab: ["login", "workspace", "dashboard"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
    ],
    []
  );

  assert.equal(stats.get("login")?.reviewUnitCount, 3);
  assert.equal(stats.get("login")?.descriptorCount, 3);
  assert.equal(stats.get("login")?.idf, 0);
  assert.equal(stats.get("export report")?.reviewUnitCount, 1);

  const analysis = analyzePrerequisites(["login", "workspace", "export report"], stats, {
    maxIdf: 0.9,
    minDistinctDescriptorCount: 3,
  });

  assert.deepEqual(analysis.prerequisiteTerms, ["login", "workspace"]);
  assert.deepEqual(analysis.primaryTerms, ["export report"]);
});

test("prerequisite analysis suppresses common terms even when they appear in the middle of a flow term list", async () => {
  const { collectVocabStats, analyzePrerequisites } = await import(path.join(repoRoot, "dist", "shared", "flow-suppression.js"));

  const stats = collectVocabStats(
    [
      {
        activeDescriptor: "Export report from workspace",
        proposedDescriptor: "Export report from workspace",
        activeVocab: ["export report", "login", "workspace"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
      {
        activeDescriptor: "Create report from workspace",
        proposedDescriptor: "Create report from workspace",
        activeVocab: ["create report", "login", "workspace"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
      {
        activeDescriptor: "View dashboard from workspace",
        proposedDescriptor: "View dashboard from workspace",
        activeVocab: ["dashboard", "login", "workspace"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
    ],
    []
  );

  const analysis = analyzePrerequisites(["export report", "login", "workspace"], stats, {
    maxIdf: 0.9,
    minDistinctDescriptorCount: 3,
  });

  assert.deepEqual(analysis.prerequisiteTerms, ["login", "workspace"]);
  assert.deepEqual(analysis.primaryTerms, ["export report"]);
});

test("prerequisite analysis preserves distinctive terms and keeps one primary term even when others are suppressed", async () => {
  const { collectVocabStats, analyzePrerequisites } = await import(path.join(repoRoot, "dist", "shared", "flow-suppression.js"));

  const stats = collectVocabStats(
    [
      {
        activeDescriptor: "Login and workspace",
        proposedDescriptor: "Login and workspace",
        activeVocab: ["login", "workspace"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
      {
        activeDescriptor: "Login and workspace on reports",
        proposedDescriptor: "Login and workspace on reports",
        activeVocab: ["login", "workspace"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
      {
        activeDescriptor: "Export report",
        proposedDescriptor: "Export report",
        activeVocab: ["export report", "report"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
      {
        activeDescriptor: "Download report",
        proposedDescriptor: "Download report",
        activeVocab: ["download report", "report"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
    ],
    []
  );

  const distinctive = analyzePrerequisites(["export report", "report"], stats, {
    maxIdf: 0.9,
    minDistinctDescriptorCount: 3,
  });
  assert.deepEqual(distinctive.prerequisiteTerms, []);
  assert.deepEqual(distinctive.primaryTerms, ["export report", "report"]);

  const fallbackPrimary = analyzePrerequisites(["login", "workspace"], stats, {
    maxIdf: 0.9,
    minDistinctDescriptorCount: 2,
  });
  assert.equal(fallbackPrimary.primaryTerms.length, 1);
  assert.equal(fallbackPrimary.prerequisiteTerms.length, 1);
});

test("common but important terms are not suppressed when they stay distinctive within a small related set", async () => {
  const { collectVocabStats, analyzePrerequisites } = await import(path.join(repoRoot, "dist", "shared", "flow-suppression.js"));

  const stats = collectVocabStats(
    [
      {
        activeDescriptor: "Export report to CSV",
        proposedDescriptor: "Export report to CSV",
        activeVocab: ["export report", "csv"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
      {
        activeDescriptor: "Export report to PDF",
        proposedDescriptor: "Export report to PDF",
        activeVocab: ["export report", "pdf"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
      {
        activeDescriptor: "Search results",
        proposedDescriptor: "Search results",
        activeVocab: ["search", "search results"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
      {
        activeDescriptor: "Dashboard",
        proposedDescriptor: "Dashboard",
        activeVocab: ["dashboard"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
    ],
    []
  );

  const analysis = analyzePrerequisites(["export report", "csv"], stats, {
    maxIdf: 0.9,
    minDistinctDescriptorCount: 3,
  });

  assert.deepEqual(analysis.prerequisiteTerms, []);
  assert.deepEqual(analysis.primaryTerms, ["export report", "csv"]);
});

test("generic meta terms do not become the only primary terms when a stronger domain term exists", async () => {
  const { collectVocabStats, analyzePrerequisites } = await import(path.join(repoRoot, "dist", "shared", "flow-suppression.js"));

  const stats = collectVocabStats(
    [
      {
        activeDescriptor: "Dashboard after login",
        proposedDescriptor: "Dashboard after login",
        activeVocab: ["dashboard", "login", "success"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
      {
        activeDescriptor: "Reports after login",
        proposedDescriptor: "Reports after login",
        activeVocab: ["reports", "login", "success"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
      {
        activeDescriptor: "Settings after login",
        proposedDescriptor: "Settings after login",
        activeVocab: ["settings", "login", "success"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
      {
        activeDescriptor: "Redirect after login",
        proposedDescriptor: "Redirect after login",
        activeVocab: ["dashboard", "login", "redirect"],
        approvedVocabUsed: [],
        proposedVocab: [],
      },
    ],
    []
  );

  const analysis = analyzePrerequisites(["dashboard", "login", "success"], stats, {
    maxIdf: 0.9,
    minDistinctDescriptorCount: 3,
  });

  assert.deepEqual(analysis.primaryTerms, ["dashboard"]);
  assert.deepEqual(analysis.prerequisiteTerms.sort(), ["login", "success"].sort());
});

test("review unit views expose prerequisite concepts and primary terms", async () => {
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
            proposedVocab: ["login", "workspace", "export report"],
            activeDescriptor: "Task A",
            activeVocab: ["login", "workspace", "export report"],
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
            proposedVocab: ["login", "workspace", "create report"],
            activeDescriptor: "Task B",
            activeVocab: ["login", "workspace", "create report"],
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
            proposedVocab: ["login", "workspace", "dashboard"],
            activeDescriptor: "Task C",
            activeVocab: ["login", "workspace", "dashboard"],
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
    assert.deepEqual(flowA.prerequisites, ["login", "workspace"]);
    assert.deepEqual(flowA.primaryTerms, ["export report"]);
  } finally {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("source-aware term extraction and semantic index preserve setup/action/end-state distinctions", async () => {
  const { collectVocabStats, inferSourceAwareTermCandidates } = await import(path.join(repoRoot, "dist", "shared", "flow-suppression.js"));
  const { buildSemanticIndex, dedupeFlowTermCandidates } = await import(path.join(repoRoot, "dist", "shared", "semantic-index.js"));

  const reviewUnits = [
    {
      activeDescriptor: "Search results",
      proposedDescriptor: "Search results",
      activeVocab: ["search", "search results", "dashboard"],
      approvedVocabUsed: [],
      proposedVocab: [],
    },
    {
      activeDescriptor: "Settings page",
      proposedDescriptor: "Settings page",
      activeVocab: ["settings", "login"],
      approvedVocabUsed: [],
      proposedVocab: [],
    },
  ];
  const stats = collectVocabStats(reviewUnits, []);
  const rawCandidates = inferSourceAwareTermCandidates(
    {
      setupValues: ["http://127.0.0.1:4010/dashboard", "login-success-settings"],
      actionValues: ['button("Search")', 'form("Search query Search")'],
      endStateValues: ["Search Results", "http://127.0.0.1:4010/search/results?q=wdyt"],
      registryTerms: [],
    },
    stats,
    []
  );
  const candidates = dedupeFlowTermCandidates(rawCandidates);
  const semanticIndex = buildSemanticIndex(reviewUnits, [], stats);
  const sourcesByTerm = new Map();
  for (const candidate of candidates) {
    const current = sourcesByTerm.get(candidate.term) ?? new Set();
    current.add(candidate.source);
    sourcesByTerm.set(candidate.term, current);
  }
  const rawSourcesByTerm = new Map();
  for (const candidate of rawCandidates) {
    const current = rawSourcesByTerm.get(candidate.term) ?? new Set();
    current.add(candidate.source);
    rawSourcesByTerm.set(candidate.term, current);
  }

  assert.ok(sourcesByTerm.get("dashboard")?.has("setup"));
  assert.ok(sourcesByTerm.get("search results")?.has("end-state"));
  assert.ok(rawSourcesByTerm.get("search")?.has("action"));
  assert.ok(rawSourcesByTerm.get("search results")?.has("end-state"));
  assert.ok(!rawCandidates.some((candidate) => candidate.term === "d"));

  const neighbors = semanticIndex.search({ term: "search results", source: "end-state" }, 3);
  assert.ok(neighbors.some((neighbor) => neighbor.term === "search"));
});

test("concept canonicalization collapses auth aliases before role scoring", async () => {
  const { canonicalizeSemanticTerms } = await import(path.join(repoRoot, "dist", "shared", "vocabulary.js"));

  assert.deepEqual(
    canonicalizeSemanticTerms(["sign in", "login", "username password sign in"], []),
    ["login"]
  );
  assert.deepEqual(canonicalizeSemanticTerms(["demo login", "log in"], []), ["login"]);
  assert.deepEqual(canonicalizeSemanticTerms(["sign out", "logout"], []), ["logout"]);
  assert.deepEqual(canonicalizeSemanticTerms(["success", "login"], []), ["login"]);
});

test("structured evidence compacts incremental input targets into semantic input items", async () => {
  const { collectStructuredEvidenceItems } = await import(path.join(repoRoot, "dist", "shared", "semantic-stages.js"));

  const items = collectStructuredEvidenceItems({
    setupUrls: ["http://127.0.0.1:4010/login"],
    actionTargets: [
      'form("Username Password Sign in")',
      'form("Search query Search")',
      'button("Sign in")',
      'input("d")',
      'input("de")',
      'input("demo")',
      'input("w")',
      'input("wdyt")',
    ],
    finalUrls: ["http://127.0.0.1:4010/dashboard"],
    titles: ["Dashboard"],
    headings: ["Dashboard"],
    alerts: [],
  });

  const actionValues = items.filter((item) => item.kind === "target").map((item) => item.value);
  assert.ok(actionValues.includes('input("credentials")'));
  assert.ok(actionValues.includes('input("search query")'));
  assert.ok(!actionValues.includes('input("d")'));
  assert.ok(!actionValues.includes('input("demo")'));
  assert.ok(!actionValues.includes('input("wdyt")'));
});

test("concept resolver groups extracted terms into resolved concepts with evidence", async () => {
  const { createInMemorySemanticIndex } = await import(path.join(repoRoot, "dist", "shared", "semantic-index.js"));
  const { resolveFlowConcepts, resolvedConceptsToCandidates, summarizeRoleEvidence } = await import(path.join(repoRoot, "dist", "shared", "concept-resolver.js"));

  const semanticIndex = createInMemorySemanticIndex([
    { term: "login", source: "historical", normalized: "login", tokens: new Set(["login"]) },
    { term: "logout", source: "historical", normalized: "logout", tokens: new Set(["logout"]) },
    { term: "workspace details", source: "historical", normalized: "workspace details", tokens: new Set(["workspace", "details"]) },
  ]);

  const resolved = resolveFlowConcepts({
    candidates: [
      { term: "sign in", source: "action" },
      { term: "log in", source: "setup" },
      { term: "sign out", source: "action" },
      { term: "workspace details", source: "end-state" },
    ],
    semanticIndex,
    vocabulary: [],
  });

  assert.ok(resolved.some((concept) => concept.term === "login"));
  assert.ok(resolved.some((concept) => concept.term === "logout"));
  assert.ok(resolved.some((concept) => concept.term === "workspace details"));
  assert.ok(resolved.find((concept) => concept.term === "logout")?.sources.includes("action"));

  const candidates = resolvedConceptsToCandidates(resolved);
  assert.ok(candidates.some((candidate) => candidate.term === "logout" && candidate.source === "action"));

  const evidence = summarizeRoleEvidence({
    concepts: resolved,
    prerequisiteTerms: ["login"],
    primaryTerms: ["logout", "workspace details"],
  });
  assert.ok(evidence.rationale.some((line) => line.includes("logout: primary")));
});

test("llm concept resolution consolidates decorated variants into canonical concepts", async () => {
  const { normalizeConceptResolution } = await import(path.join(repoRoot, "dist", "shared", "semantic-stages.js"));
  const { createInMemorySemanticIndex } = await import(path.join(repoRoot, "dist", "shared", "semantic-index.js"));

  const evidenceItems = [
    { id: "a1", kind: "target", value: 'button("Sign in")', inferredBucket: "action", bucket: "action", confidence: 0.9 },
    { id: "s1", kind: "url", value: "http://127.0.0.1:4010/login", inferredBucket: "setup", bucket: "setup", confidence: 0.9 },
    { id: "e1", kind: "url", value: "http://127.0.0.1:4010/dashboard", inferredBucket: "end-state", bucket: "end-state", confidence: 0.9 },
  ];
  const semanticIndex = createInMemorySemanticIndex([
    { term: "login", source: "historical", normalized: "login", tokens: new Set(["login"]) },
    { term: "dashboard", source: "historical", normalized: "dashboard", tokens: new Set(["dashboard"]) },
  ]);

  const resolved = normalizeConceptResolution({
    value: {
      concepts: [
        { term: "user login", itemIds: ["a1", "s1"], confidence: 0.9 },
        { term: "login page", itemIds: ["s1"], confidence: 0.9 },
        { term: "dashboard page", itemIds: ["e1"], confidence: 0.9 },
      ],
    },
    evidenceItems,
    fallbackCandidates: [],
    semanticIndex,
    vocabulary: [],
  });

  assert.ok(resolved.some((concept) => concept.term === "login"));
  assert.ok(resolved.some((concept) => concept.term === "dashboard"));
  assert.equal(resolved.filter((concept) => concept.term === "login").length, 1);
  assert.equal(resolved.filter((concept) => concept.term === "dashboard").length, 1);
});

test("concept filtering suppresses low-value operational concepts when stronger concepts exist", async () => {
  const { filterResolvedConcepts } = await import(path.join(repoRoot, "dist", "shared", "semantic-stages.js"));

  const filtered = filterResolvedConcepts([
    { term: "credential input", rawTerms: ["input credentials"], sources: ["action"], confidence: 0.8, strategy: "llm-resolved", neighbors: [] },
    { term: "search link", rawTerms: ["a back to search"], sources: ["action"], confidence: 0.8, strategy: "llm-resolved", neighbors: [] },
    { term: "login", rawTerms: ["sign in"], sources: ["action", "setup"], confidence: 0.95, strategy: "llm-resolved", neighbors: [] },
    { term: "search", rawTerms: ["open search"], sources: ["action"], confidence: 0.95, strategy: "llm-resolved", neighbors: [] },
    { term: "search results", rawTerms: ["search results"], sources: ["end-state"], confidence: 0.95, strategy: "llm-resolved", neighbors: [] },
  ]);

  assert.deepEqual(filtered.map((concept) => concept.term).sort(), ["login", "search", "search results"]);
});

test("role rebalance demotes auth primary when stronger downstream concepts exist", async () => {
  const { rebalanceClassifiedRoles } = await import(path.join(repoRoot, "dist", "shared", "role-rebalance.js"));

  const rebalanced = rebalanceClassifiedRoles(
    {
      prerequisiteTerms: ["dashboard"],
      primaryTerms: ["login"],
      outcomeTerms: ["settings"],
      uncertainTerms: [],
    },
    [
      { term: "dashboard", rawTerms: ["dashboard"], sources: ["setup"], confidence: 0.9, strategy: "llm-resolved", neighbors: [] },
      { term: "login", rawTerms: ["login"], sources: ["action", "setup"], confidence: 0.95, strategy: "llm-resolved", neighbors: [] },
      { term: "settings", rawTerms: ["settings"], sources: ["action", "end-state"], confidence: 0.95, strategy: "llm-resolved", neighbors: [] },
    ]
  );

  assert.deepEqual(rebalanced.primaryTerms, ["settings"]);
  assert.deepEqual(rebalanced.prerequisiteTerms, ["login"]);
  assert.deepEqual(rebalanced.outcomeTerms, []);
});

test("role rebalance keeps auth-only flows auth-led and compacts prerequisites", async () => {
  const { rebalanceClassifiedRoles } = await import(path.join(repoRoot, "dist", "shared", "role-rebalance.js"));

  const loginSuccess = rebalanceClassifiedRoles(
    {
      prerequisiteTerms: ["login"],
      primaryTerms: ["dashboard"],
      outcomeTerms: [],
      uncertainTerms: [],
    },
    [
      { term: "login", rawTerms: ["login"], sources: ["action", "setup"], confidence: 0.95, strategy: "llm-resolved", neighbors: [] },
      { term: "dashboard", rawTerms: ["dashboard"], sources: ["end-state"], confidence: 0.95, strategy: "llm-resolved", neighbors: [] },
    ]
  );

  assert.deepEqual(loginSuccess.primaryTerms, ["login"]);
  assert.deepEqual(loginSuccess.outcomeTerms, ["dashboard"]);
  assert.deepEqual(loginSuccess.prerequisiteTerms, []);

  const logoutFlow = rebalanceClassifiedRoles(
    {
      prerequisiteTerms: ["dashboard", "login"],
      primaryTerms: ["credential input", "logout"],
      outcomeTerms: [],
      uncertainTerms: [],
    },
    [
      { term: "credential input", rawTerms: ["input credentials"], sources: ["action"], confidence: 0.8, strategy: "llm-resolved", neighbors: [] },
      { term: "dashboard", rawTerms: ["dashboard"], sources: ["setup"], confidence: 0.9, strategy: "llm-resolved", neighbors: [] },
      { term: "login", rawTerms: ["login"], sources: ["action", "end-state"], confidence: 0.9, strategy: "llm-resolved", neighbors: [] },
      { term: "logout", rawTerms: ["sign out"], sources: ["action"], confidence: 0.95, strategy: "llm-resolved", neighbors: [] },
    ]
  );

  assert.deepEqual(logoutFlow.primaryTerms, ["logout"]);
  assert.deepEqual(logoutFlow.prerequisiteTerms, ["dashboard"]);
});

test("descriptor exclusions expand auth concepts into common auth phrasings", async () => {
  const { getDescriptorExcludedTerms, isSubflowTerm } = await import(path.join(repoRoot, "dist", "shared", "role-rebalance.js"));

  const excluded = getDescriptorExcludedTerms(
    ["login", "reports"],
    {
      prerequisiteTerms: ["login"],
      primaryTerms: ["reports"],
      outcomeTerms: [],
      uncertainTerms: [],
    }
  );

  assert.ok(excluded.includes("login"));
  assert.ok(excluded.includes("authentication"));
  assert.ok(excluded.includes("after login"));
  assert.ok(excluded.includes("after authentication"));
  assert.ok(excluded.includes("signed in"));
  assert.equal(isSubflowTerm("login"), true);
  assert.equal(isSubflowTerm("reports"), false);
});

test("descriptor sanitization strips excluded auth phrasing from mixed-flow descriptors", async () => {
  const {
    sanitizeDescriptorExcludedTerms,
    buildFallbackDescriptor,
    buildProposalRetryFeedback,
    isLowValueProposalTerm,
    normalizeDescriptorStyle,
    validateProposal,
  } = await import(path.join(repoRoot, "dist", "shared", "proposal-validation.js"));

  assert.equal(
    sanitizeDescriptorExcludedTerms("Accessing reports after authentication", ["login", "after authentication"]),
    "Accessing reports"
  );
  assert.equal(
    sanitizeDescriptorExcludedTerms("Workspace details are accessed after login", ["login", "after login"]),
    "Workspace details are accessed"
  );
  assert.equal(
    buildFallbackDescriptor({
      canonical: ["NAVIGATE"],
      primaryTerms: ["login"],
      outcomeTerms: ["dashboard"],
      urls: [],
      finalUrls: [],
      titles: [],
      headings: [],
      alerts: [],
      targets: [],
    }),
    "View dashboard"
  );
  assert.equal(
    buildFallbackDescriptor({
      canonical: ["NAVIGATE"],
      primaryTerms: ["reports"],
      outcomeTerms: [],
      urls: [],
      finalUrls: [],
      titles: [],
      headings: [],
      alerts: [],
      targets: [],
    }),
    "Access reports"
  );
  assert.equal(
    buildFallbackDescriptor({
      canonical: ["NAVIGATE"],
      primaryTerms: ["settings"],
      outcomeTerms: [],
      urls: [],
      finalUrls: [],
      titles: [],
      headings: [],
      alerts: [],
      targets: [],
    }),
    "Access settings"
  );
  assert.equal(
    buildFallbackDescriptor({
      canonical: ["NAVIGATE"],
      primaryTerms: ["workspace details"],
      outcomeTerms: [],
      urls: [],
      finalUrls: [],
      titles: [],
      headings: [],
      alerts: [],
      targets: [],
    }),
    "View workspace details"
  );
  assert.equal(
    buildFallbackDescriptor({
      canonical: ["NAVIGATE"],
      primaryTerms: ["search"],
      outcomeTerms: ["search results"],
      urls: [],
      finalUrls: [],
      titles: [],
      headings: [],
      alerts: [],
      targets: [],
    }),
    "View search results"
  );
  assert.equal(normalizeDescriptorStyle("Viewing workspace details"), "View workspace details");
  assert.equal(normalizeDescriptorStyle("Access reports page after successful"), "Access reports");
  assert.match(
    buildProposalRetryFeedback([
      "The descriptor narrates low-level UI mechanics or reduced event steps instead of the semantic task or outcome.",
      "The descriptor makes an unsupported success or mutation claim.",
    ]),
    /Avoid navigation and UI mechanics/
  );
  const validation = validateProposal(
    {
      canonical: ["NAVIGATE"],
      urls: [],
      finalUrls: ["http://127.0.0.1:4010/settings"],
      titles: ["Settings"],
      headings: ["Settings"],
      alerts: [],
      targets: [],
    },
    {
      descriptor: "Settings are updated successfully",
      approvedVocab: [],
      proposedVocab: ["settings"],
      confidence: 0.7,
      rationale: "test",
    },
    []
  );
  assert.ok(validation.issues.some((issue) => issue.includes("unsupported success or mutation claim")));
  const passiveValidation = validateProposal(
    {
      canonical: ["NAVIGATE"],
      urls: [],
      finalUrls: ["http://127.0.0.1:4010/reports"],
      titles: ["Reports"],
      headings: ["Reports"],
      alerts: [],
      targets: [],
    },
    {
      descriptor: "Navigation to reports page",
      approvedVocab: [],
      proposedVocab: ["navigation"],
      confidence: 0.7,
      rationale: "test",
    },
    []
  );
  assert.ok(passiveValidation.issues.some((issue) => issue.includes("low-level UI mechanics")));
  assert.equal(isLowValueProposalTerm("execute search"), true);
  assert.equal(isLowValueProposalTerm("navigation"), true);
});

test("role rebalance preserves no results as a distinct outcome concept", async () => {
  const { normalizeConceptResolution } = await import(path.join(repoRoot, "dist", "shared", "semantic-stages.js"));
  const { createInMemorySemanticIndex } = await import(path.join(repoRoot, "dist", "shared", "semantic-index.js"));

  const resolved = normalizeConceptResolution({
    value: {
      concepts: [
        { term: "search results", itemIds: ["e1", "e2"], confidence: 0.95 },
      ],
    },
    evidenceItems: [
      { id: "e1", kind: "title", value: "No Results", inferredBucket: "end-state", bucket: "end-state", confidence: 0.95 },
      { id: "e2", kind: "heading", value: "No Results", inferredBucket: "end-state", bucket: "end-state", confidence: 0.95 },
    ],
    fallbackCandidates: [],
    semanticIndex: createInMemorySemanticIndex([]),
    vocabulary: [],
  });

  assert.deepEqual(resolved.map((concept) => concept.term), ["no results"]);
});

test("role rebalance drops search prerequisite when search results are already primary", async () => {
  const { rebalanceClassifiedRoles } = await import(path.join(repoRoot, "dist", "shared", "role-rebalance.js"));

  const rebalanced = rebalanceClassifiedRoles(
    {
      prerequisiteTerms: ["login", "search"],
      primaryTerms: ["search results"],
      outcomeTerms: [],
      uncertainTerms: [],
    },
    [
      { term: "login", rawTerms: [], sources: ["setup", "action"], confidence: 0.95, strategy: "llm-resolved", neighbors: [], supportingItemIds: [] },
      { term: "search", rawTerms: [], sources: ["setup", "action"], confidence: 0.95, strategy: "llm-resolved", neighbors: [], supportingItemIds: [] },
      { term: "search results", rawTerms: [], sources: ["end-state"], confidence: 0.95, strategy: "llm-resolved", neighbors: [], supportingItemIds: [] },
    ]
  );

  assert.deepEqual(rebalanced.prerequisiteTerms, ["login"]);
  assert.deepEqual(rebalanced.primaryTerms, ["search results"]);
});

test("concept normalization collapses wrapper concepts like execute search and search interface", async () => {
  const { normalizeConceptResolution } = await import(path.join(repoRoot, "dist", "shared", "semantic-stages.js"));
  const { createInMemorySemanticIndex } = await import(path.join(repoRoot, "dist", "shared", "semantic-index.js"));

  const resolved = normalizeConceptResolution({
    value: {
      concepts: [
        { term: "execute search", itemIds: ["e1"], confidence: 0.95 },
        { term: "search interface", itemIds: ["e2"], confidence: 0.95 },
        { term: "search results", itemIds: ["e3"], confidence: 0.95 },
      ],
    },
    evidenceItems: [
      { id: "e1", kind: "target", value: 'button("Search")', inferredBucket: "action", bucket: "action", confidence: 0.95 },
      { id: "e2", kind: "target", value: 'a("Open search")', inferredBucket: "action", bucket: "action", confidence: 0.95 },
      { id: "e3", kind: "title", value: "Search Results", inferredBucket: "end-state", bucket: "end-state", confidence: 0.95 },
    ],
    fallbackCandidates: [],
    semanticIndex: createInMemorySemanticIndex([]),
    vocabulary: [],
  });

  assert.deepEqual(resolved.map((concept) => concept.term), ["search", "search results"]);
});

test("competitive role scoring prefers end-state and action terms over setup context", async () => {
  const { collectVocabStats, inferSourceAwareTermCandidates, scoreFlowTermRoles } = await import(path.join(repoRoot, "dist", "shared", "flow-suppression.js"));
  const { buildSemanticIndex } = await import(path.join(repoRoot, "dist", "shared", "semantic-index.js"));

  const reviewUnits = [
    {
      activeDescriptor: "Login and settings",
      proposedDescriptor: "Login and settings",
      activeVocab: ["login", "settings", "dashboard", "success"],
      approvedVocabUsed: [],
      proposedVocab: [],
    },
    {
      activeDescriptor: "Login and reports",
      proposedDescriptor: "Login and reports",
      activeVocab: ["login", "reports", "dashboard", "success"],
      approvedVocabUsed: [],
      proposedVocab: [],
    },
    {
      activeDescriptor: "Search results",
      proposedDescriptor: "Search results",
      activeVocab: ["search", "search results", "dashboard", "login"],
      approvedVocabUsed: [],
      proposedVocab: [],
    },
  ];
  const stats = collectVocabStats(reviewUnits, []);
  const semanticIndex = buildSemanticIndex(reviewUnits, [], stats);

  const settingsCandidates = inferSourceAwareTermCandidates(
    {
      setupValues: ["http://127.0.0.1:4010/dashboard", "http://127.0.0.1:4010/login"],
      actionValues: ['a("Open settings")', 'button("Sign in")'],
      endStateValues: ["Settings", "http://127.0.0.1:4010/settings"],
      registryTerms: [],
    },
    stats,
    []
  );
  const settingsRoles = scoreFlowTermRoles(settingsCandidates, stats, semanticIndex);
  assert.ok(settingsRoles.primaryTerms.includes("settings"));
  assert.ok(!settingsRoles.primaryTerms.includes("dashboard"));

  const searchCandidates = inferSourceAwareTermCandidates(
    {
      setupValues: ["http://127.0.0.1:4010/dashboard", "http://127.0.0.1:4010/login"],
      actionValues: ['button("Search")', 'form("Search query Search")'],
      endStateValues: ["Search Results", "http://127.0.0.1:4010/search/results?q=wdyt"],
      registryTerms: [],
    },
    stats,
    []
  );
  const searchRoles = scoreFlowTermRoles(searchCandidates, stats, semanticIndex);
  assert.ok(searchRoles.primaryTerms.includes("search") || searchRoles.primaryTerms.includes("search results"));
  assert.ok(!searchRoles.primaryTerms.includes("dashboard"));

  const reportsCandidates = inferSourceAwareTermCandidates(
    {
      setupValues: ["http://127.0.0.1:4010/dashboard", "http://127.0.0.1:4010/login"],
      actionValues: ['a("Open reports")', 'button("Sign in")'],
      endStateValues: ["Reports", "http://127.0.0.1:4010/reports"],
      registryTerms: [],
    },
    stats,
    []
  );
  const reportsRoles = scoreFlowTermRoles(reportsCandidates, stats, semanticIndex);
  assert.ok(reportsRoles.primaryTerms.includes("reports"));
  assert.ok(!reportsRoles.primaryTerms.includes("dashboard"));

  const workspaceCandidates = inferSourceAwareTermCandidates(
    {
      setupValues: ["http://127.0.0.1:4010/dashboard", "http://127.0.0.1:4010/login"],
      actionValues: ['a("Workspace")', 'button("Details")', 'button("Sign in")'],
      endStateValues: ["Workspace", "http://127.0.0.1:4010/workspace/details"],
      registryTerms: [],
    },
    stats,
    []
  );
  const workspaceRoles = scoreFlowTermRoles(workspaceCandidates, stats, semanticIndex);
  assert.ok(workspaceRoles.primaryTerms.includes("workspace details") || workspaceRoles.primaryTerms.includes("workspace"));
  assert.ok(!workspaceRoles.primaryTerms.includes("details"));

  const logoutCandidates = inferSourceAwareTermCandidates(
    {
      setupValues: ["http://127.0.0.1:4010/dashboard", "http://127.0.0.1:4010/login"],
      actionValues: ['a("Sign out")', 'button("Sign in")'],
      endStateValues: ["Demo Login", "Sign in", "http://127.0.0.1:4010/login"],
      registryTerms: [],
    },
    stats,
    []
  );
  const logoutRoles = scoreFlowTermRoles(logoutCandidates, stats, semanticIndex);
  assert.ok(logoutRoles.primaryTerms.includes("logout"));
  assert.ok(!logoutRoles.primaryTerms.includes("login"));
});

test("capture lifecycle persists and reduces a browser flow", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-integration-"));
  const port = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const { child, getOutput } = spawnServer(tempDir, port);

  try {
    await waitForHealth(serverUrl);

    const startBootstrapUrl = buildBootstrapUrl(serverUrl, {
      action: "start",
      serverUrl,
      suiteName: "integration",
      testName: "search flow",
      tool: "integration-test",
    });
    assert.equal(
      startBootstrapUrl,
      `${serverUrl}/bootstrap?action=start&serverUrl=${encodeURIComponent(serverUrl)}&suiteName=integration&testName=search+flow&tool=integration-test`
    );

    const bootstrapHtml = await fetchBootstrap(serverUrl, {
      action: "start",
      serverUrl,
      suiteName: "integration",
      testName: "search flow",
      tool: "integration-test",
    });
    assert.match(bootstrapHtml, /WDYT initializing|WDYT capture started|WDYT bind timed out/);

    const ingested = await postJson(serverUrl, "/ingest", {
      suite: {
        id: "integration",
        name: "integration",
        normalizedName: "integration",
      },
      environment: {
        tool: "integration-test",
        browser: {
          family: "chromium",
          version: "146.0.7680.178",
          source: "bootstrap-request",
        },
      },
      endState: {
        finalUrl: "http://127.0.0.1:4010/dashboard",
        title: "Dashboard",
        heading: "Dashboard",
        alertText: null,
      },
      run: {
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

    const rawRuns = await readFile(path.join(tempDir, ".wdyt", "runs.raw.jsonl"), "utf8");
    const processedRuns = await readFile(path.join(tempDir, ".wdyt", "runs.processed.jsonl"), "utf8");

    assert.match(rawRuns, /"id":"integration"/);
    assert.match(rawRuns, /"id":"[0-9a-f-]{36}"/);
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

    await fetchBootstrap(serverUrl, {
      action: "start",
      serverUrl,
      suiteName: "integration",
      testName: "proposal flow",
      tool: "integration-test",
    });

    await postJson(serverUrl, "/ingest", {
      suite: {
        id: "integration",
        name: "integration",
        normalizedName: "integration",
      },
      environment: {
        tool: "integration-test",
        browser: {
          family: "chromium",
          version: "146.0.7680.178",
          source: "bootstrap-request",
        },
      },
      endState: {
        finalUrl: "http://127.0.0.1:4010/dashboard",
        title: "Dashboard",
        heading: "Dashboard",
        alertText: null,
      },
      run: {
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

  } finally {
    llmServer.close();
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("critical flow parsing retries once when the first LLM response is schema-invalid", { timeout: 15_000 }, async () => {
  const llmPort = randomPort();
  const llmUrl = `http://127.0.0.1:${llmPort}/v1`;
  const llmServer = await startMockLlmServer(llmPort, {
    responseSequence: [
      { name: "Reset password" },
      {
        name: "Reset password",
        interpretedSteps: ["reset password"],
        interpretedTerms: ["reset password"],
        outcome: "",
      },
    ],
  });
  const originalBaseUrl = process.env.WDYT_LLM_BASE_URL;
  const originalApiKey = process.env.WDYT_LLM_API_KEY;
  const originalModel = process.env.WDYT_LLM_MODEL;

  try {
    process.env.WDYT_LLM_BASE_URL = llmUrl;
    process.env.WDYT_LLM_API_KEY = "ollama";
    process.env.WDYT_LLM_MODEL = "mistral:instruct";

    const { parseCriticalFlow } = await import(path.join(repoRoot, "dist", "server", "critical-flows.js"));
    const parsed = await parseCriticalFlow("Reset password");

    assert.equal(parsed.name, "Reset password");
    assert.deepEqual(parsed.interpretedSteps, ["reset password"]);
    assert.deepEqual(parsed.interpretedTerms, ["reset password"]);
  } finally {
    process.env.WDYT_LLM_BASE_URL = originalBaseUrl;
    process.env.WDYT_LLM_API_KEY = originalApiKey;
    process.env.WDYT_LLM_MODEL = originalModel;
    llmServer.close();
  }
});

test("review proposal prompt uses registry matches and canonical approved vocabulary", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-review-sanitize-"));
  const port = randomPort();
  const llmPort = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const llmUrl = `http://127.0.0.1:${llmPort}/v1`;
  const { child } = spawnServer(tempDir, port);
  const capturedRequests = [];
  const llmServer = await startMockLlmServer(llmPort, {
    responseContent: {
      descriptor: "User enters search query 'wdyt testing' and receives an error message on Google Search",
      approvedVocab: ["google search"],
      proposedVocab: ["error message", "search query"],
      confidence: 0.8,
      rationale: "The flow shows a search followed by an error page.",
    },
    onRequest: (body) => {
      capturedRequests.push(body);
    },
  });

  try {
    await waitForHealth(serverUrl);

    await postJson(serverUrl, "/review/vocabulary", {
      term: "Google Search",
      status: "approved",
      aliases: ["google search", "google"],
    });

    await fetchBootstrap(serverUrl, {
      action: "start",
      serverUrl,
      suiteName: "integration",
      testName: "search error flow",
      tool: "integration-test",
    });

    await postJson(serverUrl, "/ingest", {
      suite: {
        id: "integration",
        name: "integration",
        normalizedName: "integration",
      },
      environment: {
        tool: "integration-test",
        browser: {
          family: "chromium",
          version: "146.0.7680.178",
          source: "bootstrap-request",
        },
      },
      endState: {
        finalUrl: "https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dwdyt%2Btesting",
        title: "Google Search",
        heading: null,
        alertText: "There was an error",
      },
      run: {
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

    const evidenceRequest = capturedRequests.find((request) =>
      String(request?.messages?.[0]?.content ?? "").includes("label each provided evidence item with one bucket")
    );
    const conceptRequest = capturedRequests.find((request) =>
      String(request?.messages?.[0]?.content ?? "").includes("group classified evidence items into reusable semantic concepts")
    );
    const roleRequest = capturedRequests.find((request) =>
      String(request?.messages?.[1]?.content ?? "").includes('"semanticNeighbors"')
    );
    const descriptorRequest = capturedRequests.find((request) =>
      String(request?.messages?.[0]?.content ?? "").includes("Step 1 — Extract signals")
    );

    assert.ok(evidenceRequest);
    assert.match(evidenceRequest.messages[1].content, /"evidenceItems": \[/);
    assert.ok(conceptRequest);
    assert.match(conceptRequest.messages[1].content, /"candidateConceptHints": \[/);
    assert.ok(roleRequest);
    assert.match(roleRequest.messages[1].content, /"evidenceItems": \[/);
    assert.match(roleRequest.messages[1].content, /"setupTerms": \[/);
    assert.match(roleRequest.messages[1].content, /"actionTerms": \[/);
    assert.match(roleRequest.messages[1].content, /"endStateTerms": \[/);
    assert.match(roleRequest.messages[1].content, /"semanticNeighbors": \{/);
    assert.ok(descriptorRequest);
    assert.match(descriptorRequest.messages[0].content, /Step 1 — Extract signals/);
    assert.match(descriptorRequest.messages[0].content, /Use registryMatches if clearly relevant/);
    assert.match(descriptorRequest.messages[0].content, /approvedVocab contains only canonical terms/);
    assert.match(descriptorRequest.messages[0].content, /descriptor should normally be expressible without mentioning prerequisiteTerms/);
    assert.match(descriptorRequest.messages[1].content, /"registryMatches": \[\n\s+"Google Search"\n\s+\]/);
    assert.match(descriptorRequest.messages[1].content, /"allFlowTerms": \[/);
    assert.match(reviewOutput, /Approved vocab: Google Search/);
    assert.match(reviewOutput, /Proposed vocab: error message, search query/);
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

    await fetchBootstrap(serverUrl, {
      action: "start",
      serverUrl,
      suiteName: "integration",
      testName: "retry proposal flow",
      tool: "integration-test",
    });

    await postJson(serverUrl, "/ingest", {
      suite: {
        id: "integration",
        name: "integration",
        normalizedName: "integration",
      },
      environment: {
        tool: "integration-test",
        browser: {
          family: "chromium",
          version: "146.0.7680.178",
          source: "bootstrap-request",
        },
      },
      endState: {
        finalUrl: "https://www.google.com/sorry/index",
        title: "Google Search",
        heading: null,
        alertText: "There was an error",
      },
      run: {
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

    const descriptorRequest = requests.find((request) =>
      String(request?.messages?.[0]?.content ?? "").includes("Step 1 — Extract signals")
    );

    assert.equal(requests.length, 5);
    assert.ok(descriptorRequest);
    assert.match(descriptorRequest.messages[0].content, /Else propose new terms \(only if needed\)/);
    assert.match(descriptorRequest.messages[0].content, /proposedVocab:[\s\S]*max 3 items/);
    assert.match(descriptorRequest.messages[0].content, /if vocabulary is empty, briefly explain why evidence is insufficient/);
    assert.match(reviewOutput, /Proposed descriptor: Access search/);
    assert.match(reviewOutput, /Confidence: 0\.20/);
    assert.match(reviewOutput, /Proposed vocab: -/);
  } finally {
    llmServer.close();
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("review raises confidence for explicit successful end-state signals", { timeout: 15_000 }, async () => {
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

    await fetchBootstrap(serverUrl, {
      action: "start",
      serverUrl,
      suiteName: "integration",
      testName: "search-results",
      tool: "integration-test",
    });

    await postJson(serverUrl, "/ingest", {
      suite: {
        id: "integration",
        name: "integration",
        normalizedName: "integration",
      },
      environment: {
        tool: "integration-test",
        browser: {
          family: "chromium",
          version: "146.0.7680.178",
          source: "bootstrap-request",
        },
      },
      endState: {
        finalUrl: "http://127.0.0.1:4010/search/results?q=wdyt",
        title: "Search Results",
        heading: "Search Results",
        alertText: null,
      },
      run: {
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

    assert.match(reviewOutput, /Confidence: 0\.70/);
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

    await fetchBootstrap(serverUrl, {
      action: "start",
      serverUrl,
      suiteName: "integration",
      testName: "login-success-dashboard",
      tool: "integration-test",
    });

    await postJson(serverUrl, "/ingest", {
      suite: {
        id: "integration",
        name: "integration",
        normalizedName: "integration",
      },
      environment: {
        tool: "integration-test",
        browser: {
          family: "chromium",
          version: "146.0.7680.178",
          source: "bootstrap-request",
        },
      },
      endState: {
        finalUrl: "http://127.0.0.1:4010/dashboard",
        title: "Dashboard",
        heading: "Dashboard",
        alertText: null,
      },
      run: {
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

    assert.match(reviewOutput, /Confidence: 0\.70/);
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

    await fetchBootstrap(serverUrl, {
      action: "start",
      serverUrl,
      suiteName: "integration",
      testName: "login-success-dashboard",
      tool: "integration-test",
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
      suite: { id: "integration", name: "integration", normalizedName: "integration" },
      environment: {
        tool: "integration-test",
        browser: { family: "chromium", version: "146.0.7680.178", source: "bootstrap-request" },
      },
      endState: {
        finalUrl: "http://127.0.0.1:4010/dashboard",
        title: "Dashboard",
        heading: "Dashboard",
        alertText: null,
      },
      run: {
        testName: "login-success-dashboard",
        startedAt: 0,
        endedAt: 1,
        reason: "completed",
      },
      events: sharedEvents,
    });

    await postJson(serverUrl, "/ingest", {
      suite: { id: "integration", name: "integration", normalizedName: "integration" },
      environment: {
        tool: "integration-test",
        browser: { family: "chromium", version: "146.0.7680.178", source: "bootstrap-request" },
      },
      endState: {
        finalUrl: "http://127.0.0.1:4010/login",
        title: "Demo Login",
        heading: "Sign in",
        alertText: "Invalid username or password.",
      },
      run: {
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

    const reviewFile = await waitForCondition(async () => {
      try {
        const contents = JSON.parse(await readFile(path.join(tempDir, ".wdyt", "review-units.json"), "utf8"));
        return Array.isArray(contents) && contents.length === 2 ? contents : false;
      } catch {
        return false;
      }
    });
    assert.equal(reviewFile.length, 2);
    assert.ok(reviewFile.every((record) => typeof record.reviewId === "string"));
    assert.ok(reviewFile.every((record) => typeof record.flowId === "string"));
    assert.ok(reviewFile.every((record) => record.reviewId === record.flowId || record.reviewId.startsWith(`${record.flowId}:`)));
  } finally {
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("artifact command packages current wdyt runtime state with manifest", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-artifact-"));
  const dataDir = path.join(tempDir, ".wdyt");

  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "runs.raw.jsonl"), `${JSON.stringify({ run: { id: "raw-1" } })}\n`, "utf8");
    await writeFile(path.join(dataDir, "runs.processed.jsonl"), `${JSON.stringify({ runId: "processed-1" })}\n`, "utf8");
    await writeFile(
      path.join(dataDir, "review-units.json"),
      `${JSON.stringify([{ reviewId: "unit-1", flowId: "flow-1" }], null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(dataDir, "critical-flows.json"),
      `${JSON.stringify([{ id: "critical-1", name: "Critical flow" }], null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(dataDir, "nested.json"),
      `${JSON.stringify({ nested: true }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(path.join(dataDir, "ignore.txt"), "not included\n", "utf8");

    const artifactHelp = await runCli(tempDir, ["artifact"]);
    assert.match(artifactHelp, /wdyt artifact export \[--format zip\|pdf\] \[--output <path>\]/);
    assert.match(artifactHelp, /wdyt artifact import <zip-path> \[more-zip-paths\.\.\.\]/);
    assert.match(artifactHelp, /zip: \.\/wdyt-artifact\.zip/);
    assert.match(artifactHelp, /pdf: \.\/wdyt-report\.pdf/);

    const zipPath = await runCli(tempDir, ["artifact", "export"]);
    assert.match(zipPath, /wdyt-artifact\.zip$/);

    const zipEntries = await readZipEntries(zipPath);
    assert.ok(zipEntries.has("manifest.json"));
    assert.ok(zipEntries.has("data/runs.raw.jsonl"));
    assert.ok(zipEntries.has("data/runs.processed.jsonl"));
    assert.ok(zipEntries.has("data/review-units.json"));
    assert.ok(zipEntries.has("data/critical-flows.json"));
    assert.ok(zipEntries.has("data/nested.json"));
    assert.equal(zipEntries.has("data/ignore.txt"), false);

    const manifest = JSON.parse(zipEntries.get("manifest.json").toString("utf8"));
    assert.equal(manifest.schemaVersion, "1.0");
    assert.equal(manifest.wdytVersion, "0.1.0");
    assert.equal(manifest.entrypoints.rawRuns, "data/runs.raw.jsonl");
    assert.equal(manifest.entrypoints.processedRuns, "data/runs.processed.jsonl");
    assert.equal(manifest.entrypoints.reviewUnits, "data/review-units.json");
    assert.equal(manifest.entrypoints.criticalFlows, "data/critical-flows.json");
    assert.equal(manifest.stats.totalRawRecords, 1);
    assert.equal(manifest.stats.totalProcessedRecords, 1);
    assert.equal(manifest.stats.totalReviewUnits, 1);
    assert.equal(manifest.stats.totalCriticalFlows, 1);
    assert.ok(Array.isArray(manifest.files));
    assert.ok(manifest.files.some((file) => file.path === "data/nested.json"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("artifact import restores runtime JSON artifacts from zip", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-artifact-import-"));
  const dataDir = path.join(tempDir, ".wdyt");

  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "runs.raw.jsonl"), `${JSON.stringify({ run: { id: "raw-1" } })}\n`, "utf8");
    await writeFile(path.join(dataDir, "runs.processed.jsonl"), `${JSON.stringify({ runId: "processed-1" })}\n`, "utf8");
    await writeFile(
      path.join(dataDir, "review-units.json"),
      `${JSON.stringify([{ reviewId: "unit-1", flowId: "flow-1" }], null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(dataDir, "critical-flows.json"),
      `${JSON.stringify([{ id: "critical-1", name: "Critical flow" }], null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(dataDir, "nested.json"),
      `${JSON.stringify({ nested: true }, null, 2)}\n`,
      "utf8"
    );

    const zipPath = await runCli(tempDir, ["artifact", "export"]);

    await writeFile(path.join(dataDir, "runs.raw.jsonl"), `${JSON.stringify({ run: { id: "raw-overwritten" } })}\n`, "utf8");
    await rm(path.join(dataDir, "review-units.json"), { force: true });
    await writeFile(path.join(dataDir, "stale.json"), `${JSON.stringify({ stale: true }, null, 2)}\n`, "utf8");

    const importedDataDir = await runCli(tempDir, ["artifact", "import", zipPath]);
    assert.match(importedDataDir, /\.wdyt$/);

    assert.equal(await readFile(path.join(dataDir, "runs.raw.jsonl"), "utf8"), `${JSON.stringify({ run: { id: "raw-1" } })}\n`);
    assert.equal(await readFile(path.join(dataDir, "runs.processed.jsonl"), "utf8"), `${JSON.stringify({ runId: "processed-1" })}\n`);
    assert.equal(
      await readFile(path.join(dataDir, "review-units.json"), "utf8"),
      `${JSON.stringify([{ reviewId: "unit-1", flowId: "flow-1" }], null, 2)}\n`
    );
    assert.equal(
      await readFile(path.join(dataDir, "critical-flows.json"), "utf8"),
      `${JSON.stringify([{ id: "critical-1", name: "Critical flow" }], null, 2)}\n`
    );
    assert.equal(
      await readFile(path.join(dataDir, "nested.json"), "utf8"),
      `${JSON.stringify({ nested: true }, null, 2)}\n`
    );

    const staleExists = await stat(path.join(dataDir, "stale.json"))
      .then(() => true)
      .catch(() => false);
    assert.equal(staleExists, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("artifact import accepts multiple zip paths and merges runtime artifacts", { timeout: 15_000 }, async () => {
  const sourceADir = await mkdtemp(path.join(os.tmpdir(), "wdyt-artifact-import-multi-a-"));
  const sourceBDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-artifact-import-multi-b-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-artifact-import-multi-target-"));
  const zipAPath = path.join(sourceADir, "artifact-a.zip");
  const zipBPath = path.join(sourceBDir, "artifact-b.zip");

  try {
    await mkdir(path.join(sourceADir, ".wdyt"), { recursive: true });
    await writeFile(
      path.join(sourceADir, ".wdyt", "runs.raw.jsonl"),
      `${JSON.stringify({ run: { id: "raw-a" } })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(sourceADir, ".wdyt", "review-units.json"),
      `${JSON.stringify([{ reviewId: "unit-a", flowId: "flow-a" }], null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(sourceADir, ".wdyt", "critical-flows.json"),
      `${JSON.stringify([{ id: "critical-a", name: "Behavior A" }], null, 2)}\n`,
      "utf8"
    );
    await runCli(sourceADir, ["artifact", "export", "--output", zipAPath]);

    await mkdir(path.join(sourceBDir, ".wdyt"), { recursive: true });
    await writeFile(
      path.join(sourceBDir, ".wdyt", "runs.raw.jsonl"),
      `${JSON.stringify({ run: { id: "raw-b" } })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(sourceBDir, ".wdyt", "review-units.json"),
      `${JSON.stringify([{ reviewId: "unit-b", flowId: "flow-b" }], null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(sourceBDir, ".wdyt", "critical-flows.json"),
      `${JSON.stringify([{ id: "critical-b", name: "Behavior B" }], null, 2)}\n`,
      "utf8"
    );
    await runCli(sourceBDir, ["artifact", "export", "--output", zipBPath]);

    const importedDataDir = await runCli(targetDir, ["artifact", "import", zipAPath, zipBPath]);
    assert.match(importedDataDir, /\.wdyt$/);

    assert.equal(
      await readFile(path.join(targetDir, ".wdyt", "runs.raw.jsonl"), "utf8"),
      `${JSON.stringify({ run: { id: "raw-a" } })}\n${JSON.stringify({ run: { id: "raw-b" } })}\n`
    );
    assert.equal(
      await readFile(path.join(targetDir, ".wdyt", "review-units.json"), "utf8"),
      `${JSON.stringify(
        [
          { reviewId: "unit-a", flowId: "flow-a" },
          { reviewId: "unit-b", flowId: "flow-b" },
        ],
        null,
        2
      )}\n`
    );
    assert.equal(
      await readFile(path.join(targetDir, ".wdyt", "critical-flows.json"), "utf8"),
      `${JSON.stringify(
        [
          { id: "critical-a", name: "Behavior A" },
          { id: "critical-b", name: "Behavior B" },
        ],
        null,
        2
      )}\n`
    );
  } finally {
    await rm(sourceADir, { recursive: true, force: true });
    await rm(sourceBDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("empty runtime shows launchpad and accepts multi-file artifact upload", { timeout: 20_000 }, async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-launchpad-source-"));
  const sourceDirB = await mkdtemp(path.join(os.tmpdir(), "wdyt-launchpad-source-b-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-launchpad-target-"));
  const sourcePort = randomPort();
  const sourcePortB = randomPort();
  const targetPort = randomPort();
  const sourceUrl = `http://127.0.0.1:${sourcePort}`;
  const sourceUrlB = `http://127.0.0.1:${sourcePortB}`;
  const targetUrl = `http://127.0.0.1:${targetPort}`;
  const sourceServer = spawnServer(sourceDir, sourcePort);
  const sourceServerB = spawnServer(sourceDirB, sourcePortB);
  const targetServer = spawnServer(targetDir, targetPort);
  const artifactPathA = path.join(sourceDir, "fixture-artifact-a.zip");
  const artifactPathB = path.join(sourceDirB, "fixture-artifact-b.zip");

  try {
    await waitForHealth(sourceUrl);
    await waitForHealth(sourceUrlB);
    await waitForHealth(targetUrl);

    await postJson(sourceUrl, "/ingest", {
      suite: { id: "integration", name: "integration", normalizedName: "integration" },
      environment: {
        tool: "integration-test",
        browser: { family: "chromium", version: "146.0.7680.178", source: "bootstrap-request" },
      },
      endState: {
        finalUrl: "http://127.0.0.1:4010/dashboard",
        title: "Dashboard",
        heading: "Dashboard",
        alertText: null,
      },
      run: {
        testName: "launchpad-upload",
        startedAt: 0,
        endedAt: 1,
        reason: "completed",
      },
      events: [
        { type: "navigate", ts: 1000, seq: 0, url: "http://127.0.0.1:4010/login" },
        { type: "click", ts: 1010, seq: 1, target: { tag: "button", text: "Sign in" } },
        { type: "submit", ts: 1020, seq: 2, target: { tag: "form", text: "Username Password Sign in" } },
        { type: "navigate", ts: 1030, seq: 3, url: "http://127.0.0.1:4010/dashboard" },
      ],
    });

    await postJson(sourceUrlB, "/ingest", {
      suite: { id: "integration", name: "integration", normalizedName: "integration" },
      environment: {
        tool: "integration-test",
        browser: { family: "chromium", version: "146.0.7680.178", source: "bootstrap-request" },
      },
      endState: {
        finalUrl: "http://127.0.0.1:4010/settings",
        title: "Settings",
        heading: "Settings",
        alertText: null,
      },
      run: {
        testName: "launchpad-upload-b",
        startedAt: 0,
        endedAt: 1,
        reason: "completed",
      },
      events: [
        { type: "navigate", ts: 1000, seq: 0, url: "http://127.0.0.1:4010/login" },
        { type: "click", ts: 1010, seq: 1, target: { tag: "button", text: "Sign in" } },
        { type: "submit", ts: 1020, seq: 2, target: { tag: "form", text: "Username Password Sign in" } },
        { type: "navigate", ts: 1030, seq: 3, url: "http://127.0.0.1:4010/settings" },
      ],
    });

    await runCli(sourceDir, ["artifact", "export", "--output", artifactPathA]);
    await runCli(sourceDirB, ["artifact", "export", "--output", artifactPathB]);
    const artifactBase64A = (await readFile(artifactPathA)).toString("base64");
    const artifactBase64B = (await readFile(artifactPathB)).toString("base64");

    const emptyPage = await fetch(`${targetUrl}/review`).then((response) => response.text());
    assert.match(emptyPage, /Get started with wdyt/);
    assert.match(emptyPage, /Capture test data/);
    assert.match(emptyPage, /Upload an artifact/);
    assert.match(emptyPage, /OR/);

    const uploadResponse = await postJson(targetUrl, "/artifacts/import", {
      files: [
        { name: "fixture-a.zip", contentBase64: artifactBase64A },
        { name: "fixture-b.zip", contentBase64: artifactBase64B },
      ],
    });
    assert.equal(uploadResponse.ok, true);

    const uploadedUnits = await waitForCondition(async () => {
      const units = await getJson(targetUrl, "/review/units");
      return units.length > 0 ? units : false;
    });
    assert.equal(uploadedUnits.length, 2);

    const reviewPage = await fetch(`${targetUrl}/review`).then((response) => response.text());
    assert.doesNotMatch(reviewPage, /Get started with wdyt/);
    assert.match(reviewPage, /Observed Behaviors/);
  } finally {
    await stopChildProcess(sourceServer.child);
    await stopChildProcess(sourceServerB.child);
    await stopChildProcess(targetServer.child);
    await rm(sourceDir, { recursive: true, force: true });
    await rm(sourceDirB, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("artifact export supports an explicit output path", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-artifact-output-"));
  const dataDir = path.join(tempDir, ".wdyt");

  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "runs.raw.jsonl"), `${JSON.stringify({ run: { id: "raw-1" } })}\n`, "utf8");

    const outputDir = path.join(tempDir, "exports");
    const zipPath = await runCli(tempDir, ["artifact", "export", "--output", outputDir]);
    assert.match(zipPath, /exports\/wdyt-artifact-.*\.zip$/);

    const zipEntries = await readZipEntries(zipPath);
    assert.ok(zipEntries.has("manifest.json"));
    assert.ok(zipEntries.has("data/runs.raw.jsonl"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("artifact export supports pdf format", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-artifact-pdf-"));
  const dataDir = path.join(tempDir, ".wdyt");

  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(dataDir, "review-units.json"),
      `${JSON.stringify(
        [
          {
            reviewId: "flow-dashboard-a",
            flowId: "flow-dashboard-a",
            canonical: ["NAVIGATE"],
            count: 1,
            suites: ["integration"],
            tests: ["dashboard-a"],
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
            proposedVocab: ["dashboard"],
            activeDescriptor: "View dashboard",
            activeVocab: ["dashboard"],
            overlapTerms: ["dashboard"],
            updatedAt: 1,
          },
          {
            reviewId: "flow-dashboard-b",
            flowId: "flow-dashboard-b",
            canonical: ["NAVIGATE"],
            count: 1,
            suites: ["integration"],
            tests: ["dashboard-b"],
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
            proposedVocab: ["dashboard"],
            activeDescriptor: "View dashboard",
            activeVocab: ["dashboard"],
            overlapTerms: ["dashboard"],
            updatedAt: 1,
          },
          {
            reviewId: "flow-settings",
            flowId: "flow-settings",
            canonical: ["NAVIGATE"],
            count: 1,
            suites: ["integration"],
            tests: ["settings"],
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
            proposedVocab: ["settings"],
            activeDescriptor: "Access settings",
            activeVocab: ["settings"],
            overlapTerms: ["settings"],
            updatedAt: 1,
          },
        ],
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(dataDir, "critical-flows.json"),
      `${JSON.stringify(
        [
          {
            id: "expected-dashboard",
            name: "View dashboard",
            rawText: "View dashboard",
            interpretedSteps: ["view dashboard"],
            interpretedTerms: ["dashboard"],
            status: "covered",
            matchedDescriptorIds: ["flow-dashboard-a", "flow-dashboard-b"],
            updatedAt: 1,
          },
          {
            id: "expected-password",
            name: "Forgot password",
            rawText: "Forgot password",
            interpretedSteps: ["forgot password"],
            interpretedTerms: ["forgot password"],
            status: "not_covered",
            matchedDescriptorIds: [],
            updatedAt: 1,
          },
        ],
        null,
        2
      )}\n`,
      "utf8"
    );

    const result = await runCli(tempDir, ["artifact", "export", "--format", "pdf"], "", {
      WDYT_PDF_STUB: "1",
    });
    assert.match(result, /Report generated: .*wdyt-report\.pdf/);

    const reportBody = await readFile(path.join(tempDir, "wdyt-report.pdf"), "utf8");
    assert.match(reportBody, /%PDF-STUB/);
    assert.match(reportBody, /What Did You Test\?/);
    assert.match(reportBody, /Test Execution Summary/);
    assert.match(reportBody, /This run exercised <strong>2<\/strong> distinct behaviors, with the most frequent including:/);
    assert.match(reportBody, /View dashboard \(2\)/);
    assert.match(reportBody, /Coverage against expected behaviors shows <strong>1<\/strong> covered and <strong>1<\/strong> missing\./);
    assert.match(reportBody, /Coverage Against Expected Behaviors/);
    assert.match(reportBody, /Behaviors exercised during testing\. Counts indicate repeated coverage across multiple test scenarios\./);
    assert.match(reportBody, /Forgot password — ❌ Missing — no evidence of this behavior in test execution/);
  } finally {
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
    assert.deepEqual(proposedUnit.primaryTerms, ["search"]);
    assert.deepEqual(proposedUnit.prerequisiteTerms, ["login"]);
    assert.ok(Array.isArray(proposedUnit.evidenceItems));
    assert.ok((proposedUnit.evidenceItems?.length ?? 0) > 0);
    assert.ok(Array.isArray(proposedUnit.conceptResolutions));
    assert.ok(proposedUnit.conceptResolutions.some((concept) => concept.term === "search"));
    assert.ok(Array.isArray(proposedUnit.roleEvidence?.rationale));
    assert.ok((proposedUnit.roleEvidence?.rationale.length ?? 0) > 0);
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
  const dataDir = path.join(tempDir, ".wdyt");
  const port = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  let child;

  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(dataDir, "review-units.json"),
      `${JSON.stringify(
        [
          {
            reviewId: "flow-dashboard-a",
            flowId: "flow-dashboard-a",
            canonical: ["NAVIGATE"],
            count: 1,
            suites: ["integration"],
            tests: ["dashboard-a"],
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
            proposedVocab: ["dashboard"],
            activeDescriptor: "View dashboard",
            activeVocab: ["dashboard"],
            overlapTerms: ["dashboard"],
            updatedAt: 1,
          },
          {
            reviewId: "flow-dashboard-b",
            flowId: "flow-dashboard-b",
            canonical: ["NAVIGATE"],
            count: 1,
            suites: ["integration"],
            tests: ["dashboard-b"],
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
            proposedVocab: ["dashboard"],
            activeDescriptor: "View dashboard",
            activeVocab: ["dashboard"],
            overlapTerms: ["dashboard"],
            updatedAt: 1,
          },
          {
            reviewId: "flow-search",
            flowId: "flow-search",
            canonical: ["NAVIGATE"],
            count: 1,
            suites: ["integration"],
            tests: ["search"],
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
            proposedVocab: ["search results"],
            activeDescriptor: "View search results",
            activeVocab: ["search results"],
            overlapTerms: ["search results"],
            updatedAt: 1,
          },
        ],
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(dataDir, "critical-flows.json"),
      `${JSON.stringify(
        [
          {
            id: "expected-dashboard",
            name: "View dashboard",
            rawText: "View dashboard",
            interpretedSteps: ["view dashboard"],
            interpretedTerms: ["dashboard"],
            status: "covered",
            matchedDescriptorIds: ["flow-dashboard-a", "flow-dashboard-b"],
            updatedAt: 1,
          },
          {
            id: "expected-reset-password",
            name: "Forgot password",
            rawText: "Forgot password",
            interpretedSteps: ["reset password"],
            interpretedTerms: ["reset password"],
            status: "not_covered",
            matchedDescriptorIds: [],
            updatedAt: 1,
          },
        ],
        null,
        2
      )}\n`,
      "utf8"
    );

    ({ child } = spawnServer(tempDir, port));
    await waitForHealth(serverUrl);

    const page = await fetch(`${serverUrl}/review/summary`).then((response) => response.text());
    assert.match(page, /What Did You Test\? \| Summary/);
    assert.match(page, /See what was exercised based on observed evidence, and evaluate coverage of critical business flows\./);
    assert.match(page, /Export <span aria-hidden="true">▾<\/span>/);
    assert.match(page, /Download PDF report/);
    assert.match(page, /Download artifact \(.zip\)/);
    assert.match(page, /Coverage Against Expected Behaviors/);
    assert.match(page, /Observed Behaviors/);
    assert.match(page, /Behaviors exercised during testing\. Counts indicate repeated coverage across multiple test scenarios\./);
    assert.match(page, /Covered/);
    assert.match(page, /Partial/);
    assert.match(page, /Missing/);
    assert.doesNotMatch(page, /Repeated Coverage/);
    assert.match(page, /const formatUniqueFlowLabel = \(item\) =>/);
    assert.match(page, /item\.count > 1 \? `\$\{item\.title\} \(\$\{item\.count\}\)` : item\.title/);
    assert.doesNotMatch(page, /\* repeated coverage/);
    assert.doesNotMatch(page, /number = how many flows/);
    assert.match(page, /Observed Behaviors<\/a>\s*<a href="\/expected-behaviors">Expected Behaviors<\/a>\s*<a class="active" href="\/review\/summary">Summary<\/a>/);
  } finally {
    if (child) {
      await stopChildProcess(child);
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("summary page exports shared pdf and zip downloads", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-summary-export-"));
  const dataDir = path.join(tempDir, ".wdyt");
  const port = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  let child;

  try {
    await mkdir(dataDir, { recursive: true });
    ({ child } = spawnServer(tempDir, port, {
      WDYT_PDF_STUB: "1",
    }));
    await waitForHealth(serverUrl);
    await writeFile(
      path.join(dataDir, "review-units.json"),
      `${JSON.stringify(
        [
          {
            reviewId: "flow-dashboard-a",
            flowId: "flow-dashboard-a",
            canonical: ["NAVIGATE"],
            count: 1,
            suites: ["integration"],
            tests: ["dashboard-a"],
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
            proposedVocab: ["dashboard"],
            activeDescriptor: "View dashboard",
            activeVocab: ["dashboard"],
            overlapTerms: ["dashboard"],
            updatedAt: 1,
          },
          {
            reviewId: "flow-dashboard-b",
            flowId: "flow-dashboard-b",
            canonical: ["NAVIGATE"],
            count: 1,
            suites: ["integration"],
            tests: ["dashboard-b"],
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
            proposedVocab: ["dashboard"],
            activeDescriptor: "View dashboard",
            activeVocab: ["dashboard"],
            overlapTerms: ["dashboard"],
            updatedAt: 1,
          },
        ],
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      path.join(dataDir, "critical-flows.json"),
      `${JSON.stringify(
        [
          {
            id: "expected-dashboard",
            name: "View dashboard",
            rawText: "View dashboard",
            interpretedSteps: ["view dashboard"],
            interpretedTerms: ["dashboard"],
            status: "covered",
            matchedDescriptorIds: ["flow-dashboard-a", "flow-dashboard-b"],
            updatedAt: 1,
          },
        ],
        null,
        2
      )}\n`,
      "utf8"
    );

    const pdfResponse = await fetch(`${serverUrl}/artifacts/export?format=pdf`);
    assert.equal(pdfResponse.status, 200);
    assert.match(pdfResponse.headers.get("content-type") || "", /application\/pdf/);
    assert.match(pdfResponse.headers.get("content-disposition") || "", /wdyt-report\.pdf/);

    const pdfBody = Buffer.from(await pdfResponse.arrayBuffer()).toString("utf8");
    assert.match(pdfBody, /%PDF-STUB/);
    assert.match(pdfBody, /What Did You Test\?/);
    assert.match(pdfBody, /This run exercised <strong>1<\/strong> distinct behaviors, with the most frequent including:/);
    assert.match(pdfBody, /Coverage Against Expected Behaviors/);
    assert.match(pdfBody, /Behaviors exercised during testing\. Counts indicate repeated coverage across multiple test scenarios\./);
    assert.match(pdfBody, /View dashboard \(2\)/);

    const zipResponse = await fetch(`${serverUrl}/artifacts/export?format=zip`);
    assert.equal(zipResponse.status, 200);
    assert.match(zipResponse.headers.get("content-type") || "", /application\/zip/);
    assert.match(zipResponse.headers.get("content-disposition") || "", /wdyt-artifact\.zip/);

    const zipEntries = await readZipEntries(Buffer.from(await zipResponse.arrayBuffer()));
    assert.ok(zipEntries.has("manifest.json"));
    assert.ok(zipEntries.has("data/review-units.json"));
    assert.ok(zipEntries.has("data/critical-flows.json"));
  } finally {
    if (child) {
      await stopChildProcess(child);
    }
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

    const missingAction = await fetch(`${serverUrl}/bootstrap`).then(async (response) => ({
      status: response.status,
      body: await response.json(),
    }));
    assert.equal(missingAction.status, 400);
    assert.equal(missingAction.body.error, "bootstrap action must be 'start' or 'finalize'");

    const validBootstrap = await fetchBootstrap(serverUrl, {
      action: "start",
      serverUrl,
      suiteName: "validation",
      testName: "optional metadata omitted",
    });
    assert.match(validBootstrap, /WDYT initializing/);

    const invalidIngest = await postJsonAllowError(serverUrl, "/ingest", {
      suite: { id: "validation", name: "validation", normalizedName: "validation" },
      run: { endedAt: 1, reason: "completed" },
      events: [],
    });
    assert.equal(invalidIngest.status, 400);
    assert.equal(invalidIngest.body.error, "Invalid ingest payload");
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

    const page = await fetch(`${serverUrl}/expected-behaviors`).then((response) => response.text());
    assert.match(page, /Get started with wdyt/);
    assert.match(page, /Capture test data/);
    assert.match(page, /Upload an artifact/);
    assert.match(page, /View Getting Started guide/);

    const interpreted = await postJson(serverUrl, "/expected-behaviors/interpret", {
      rawText: "User can log in and export a report to CSV",
    });
    assert.deepEqual(interpreted.interpretedSteps, ["login", "export report"]);
    assert.deepEqual(interpreted.interpretedTerms, ["csv", "export report", "login"]);
    assert.equal(interpreted.outcome, "report exported");

    const created = await postJson(serverUrl, "/expected-behaviors", interpreted);
    assert.equal(created.status, "not_covered");
    assert.deepEqual(created.matchedDescriptorIds, []);

    const state = await getJson(serverUrl, "/expected-behaviors/state");
    assert.equal(state.hasDescriptors ?? state.hasApprovedDescriptors, false);
    assert.equal(state.flows.length, 1);
    assert.equal(state.flows[0].status, "not_covered");

    const captureGuide = await fetch(`${serverUrl}/getting-started`).then((response) => response.text());
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

    const initialState = await getJson(serverUrl, "/expected-behaviors/state");
    assert.equal(initialState.hasDescriptors ?? initialState.hasApprovedDescriptors, true);
    assert.deepEqual(initialState.suggestions, [
      "Create a report",
      "Export a report to CSV",
      "Sign in successfully",
    ]);

    const interpreted = await postJson(serverUrl, "/expected-behaviors/interpret", {
      rawText: "User can log in and create and export a report",
    });
    const created = await postJson(serverUrl, "/expected-behaviors", interpreted);

    assert.equal(created.status, "covered");
    assert.deepEqual(created.matchedDescriptorIds.sort(), [
      "descriptor-create-report",
      "descriptor-export-report",
      "descriptor-login",
    ]);

    const state = await getJson(serverUrl, "/expected-behaviors/state");
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

    const interpreted = await postJson(serverUrl, "/expected-behaviors/interpret", {
      rawText: "User can log in and create and export a report",
    });
    const created = await postJson(serverUrl, "/expected-behaviors", interpreted);
    assert.equal(created.status, "partial");

    const state = await getJson(serverUrl, "/expected-behaviors/state");
    assert.equal(state.flows[0].status, "partial");
    assert.deepEqual(state.flows[0].matchedConcepts, ["create report", "login"]);
    assert.deepEqual(state.flows[0].missingTerms, ["export report"]);

    const page = await fetch(`${serverUrl}/expected-behaviors`).then((response) => response.text());
    assert.match(page, /Coverage Gaps/);
    assert.match(page, /Missing:/);
    assert.match(page, /Missing in/);
    assert.match(page, /Interpreted Behavior/);
    assert.match(page, /Why it’s partially covered/);
    assert.match(page, /Some parts of this behavior were not found in observed test execution\./);
    assert.match(page, /The general behavior was observed, but the distinguishing qualifier details were not found\./);
    assert.doesNotMatch(page, /Interpreted Terms/);
    assert.doesNotMatch(page, /Matched Concepts/);
    assert.doesNotMatch(page, /Matching Descriptors/);
    assert.doesNotMatch(page, /Original raw text:/);
    assert.doesNotMatch(page, /Potential missing coverage/);
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

test("critical flows compare against semantic role terms when vocab is sparse", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-critical-flows-role-terms-"));
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
            proposedDescriptor: "View search results",
            proposedConfidence: 0.8,
            proposedRationale: "Search completes with results.",
            approvedVocabUsed: [],
            proposedVocab: [],
            activeDescriptor: "View search results",
            activeVocab: [],
            prerequisiteTerms: ["login"],
            primaryTerms: ["search"],
            outcomeTerms: ["search results"],
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
      rawText: "Search and display results",
      interpretedSteps: ["search", "view results"],
      interpretedTerms: ["search", "search results"],
      outcome: "results visible",
    });

    assert.equal(created.status, "covered");
    assert.deepEqual(created.matchedDescriptorIds, ["descriptor-search-results"]);

    const state = await loadCriticalFlowState();
    assert.deepEqual(state.flows[0].matchedConcepts, ["search", "search results"]);
    assert.deepEqual(state.flows[0].missingTerms, []);
  } finally {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("critical flows mark qualifier-specific behaviors as partial when only the action is observed", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-critical-flows-qualifiers-"));
  const dataDir = path.join(tempDir, ".wdyt");
  const originalCwd = process.cwd();

  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(dataDir, "review-units.json"),
      `${JSON.stringify(
        [
          {
            reviewId: "descriptor-search",
            flowId: "descriptor-search",
            canonical: ["NAVIGATE"],
            count: 1,
            suites: ["integration"],
            tests: ["search-basic"],
            tools: ["integration-test"],
            browsers: ["chromium 146"],
            urls: [],
            targets: [],
            finalUrls: [],
            titles: [],
            headings: [],
            alerts: [],
            proposalState: "proposed",
            proposedDescriptor: "Search",
            proposedConfidence: 0.8,
            proposedRationale: "Search is performed.",
            approvedVocabUsed: [],
            proposedVocab: ["search"],
            activeDescriptor: "Search",
            activeVocab: ["search"],
            primaryTerms: ["search"],
            outcomeTerms: [],
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
      name: "Search using LTR inputs",
      rawText: "Search using LTR inputs",
      interpretedSteps: ["search"],
      interpretedTerms: ["search"],
      outcome: "results visible",
    });

    assert.equal(created.status, "partial");
    assert.deepEqual(created.matchedDescriptorIds, ["descriptor-search"]);
    assert.deepEqual(created.behavior, {
      action: "search",
      qualifiers: ["ltr_inputs"],
    });

    const state = await loadCriticalFlowState();
    assert.equal(state.flows[0].status, "partial");
    assert.equal(state.flows[0].matchedAction, "Search");
    assert.deepEqual(state.flows[0].missingQualifiers, ["ltr_inputs"]);
    assert.deepEqual(state.flows[0].missingTerms, ["ltr inputs"]);
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

    const created = await postJson(serverUrl, "/expected-behaviors", {
      name: "Create a report",
      rawText: "Create a report",
      interpretedSteps: ["create report"],
      interpretedTerms: ["create report"],
      outcome: "report created",
    });
    assert.equal(created.status, "covered");

    const updated = await fetch(`${serverUrl}/expected-behaviors/${encodeURIComponent(created.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Create and export a report",
        rawText: "Create and export a report",
        interpretedSteps: ["create report", "export report"],
        interpretedTerms: ["create report", "export report"],
        outcome: "report exported",
        behavior: {
          action: "create report",
          qualifiers: ["csv_export"],
        },
      }),
    }).then((response) => response.json());

    assert.equal(updated.name, "Create and export a report");
    assert.equal(updated.status, "partial");
    assert.deepEqual(updated.behavior, {
      action: "create report",
      qualifiers: ["csv_export"],
    });

    const stateAfterUpdate = await getJson(serverUrl, "/expected-behaviors/state");
    assert.equal(stateAfterUpdate.flows.length, 1);
    assert.equal(stateAfterUpdate.flows[0].status, "partial");
    assert.deepEqual(stateAfterUpdate.flows[0].missingQualifiers, ["csv_export"]);
    assert.deepEqual(stateAfterUpdate.flows[0].missingTerms, ["csv export"]);
    assert.deepEqual(stateAfterUpdate.flows[0].behavior, {
      action: "create report",
      qualifiers: ["csv_export"],
    });

    const deleted = await fetch(`${serverUrl}/expected-behaviors/${encodeURIComponent(created.id)}`, {
      method: "DELETE",
    }).then((response) => response.json());
    assert.equal(deleted.ok, true);

    const stateAfterDelete = await getJson(serverUrl, "/expected-behaviors/state");
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
        ["search", "search results"],
      ]
    );
  } finally {
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("review page groups identical descriptors when one overlap-term set is a subset of the other", { timeout: 15_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-review-subset-overlap-"));
  const port = randomPort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const dataDir = path.join(tempDir, ".wdyt");

  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, "review-units.json"),
    `${JSON.stringify(
      [
        {
          reviewId: "search-single",
          flowId: "search-single",
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
          proposedDescriptor: "View search results",
          proposedConfidence: 0.8,
          proposedRationale: "Sample subset overlap case.",
          approvedVocabUsed: [],
          proposedVocab: ["search", "search results"],
          activeDescriptor: "View search results",
          activeVocab: ["search", "search results"],
          primaryTerms: ["search"],
          outcomeTerms: ["search results"],
          prerequisiteTerms: ["login"],
          updatedAt: 1,
        },
        {
          reviewId: "search-repeat",
          flowId: "search-repeat",
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
          proposedDescriptor: "View search results",
          proposedConfidence: 0.8,
          proposedRationale: "Sample subset overlap case.",
          approvedVocabUsed: [],
          proposedVocab: ["search results"],
          activeDescriptor: "View search results",
          activeVocab: ["search results"],
          primaryTerms: ["search results"],
          outcomeTerms: [],
          prerequisiteTerms: ["login"],
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
    ["search-single", "search-repeat"]
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
      ["search-single", "search-results"],
      ["search-repeat", "search-results-repeat"],
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
    const units = await getJson(serverUrl, "/review/units");
    const searchUnits = units.filter((unit) =>
      ["search-results", "search-results-repeat"].some((testName) => (unit.tests || []).includes(testName))
    );
    assert.equal(searchUnits.length, 2);
    assert.deepEqual(
      searchUnits.map((unit) => unit.overlapTerms).sort((a, b) => a.length - b.length || a.join(" ").localeCompare(b.join(" "))),
      [
        ["search results"],
        ["search", "search results"],
      ]
    );
    assert.match(reviewPage, /const isSubsetOverlapMatch = \(leftUnit, rightUnit\) =>/);
    assert.match(reviewPage, /return minCount > 0 && shared === minCount;/);
    assert.match(reviewPage, /matchedGroup\.key = matchedGroup\.vocab\.join\("\|\|"\);/);
  } finally {
    await stopChildProcess(child);
    await rm(tempDir, { recursive: true, force: true });
  }
});
