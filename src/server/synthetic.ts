import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

import {
  appendJsonLine,
  ensureDataDir,
  getCriticalFlowsPath,
  getProcessedRunsPath,
  getRawRunsPath,
  getReviewUnitsPath,
  getVocabularyPath,
  writeJsonFile,
} from "../shared/fs.js";
import type { IngestPayload, ProcessedRunRecord, ReducedStep } from "../shared/types.js";

type SyntheticSeedOptions = {
  units: number;
  runsPerUnit: number;
  offset?: number;
};

type SyntheticScenario = {
  name: string;
  canonical: ReducedStep[];
  urls: string[];
  targets: string[];
  endState: NonNullable<IngestPayload["endState"]>;
};

const SCENARIOS: SyntheticScenario[] = [
  {
    name: "dashboard",
    canonical: ["NAVIGATE", "INPUT", "CHANGE", "INPUT", "CHANGE", "CLICK", "SUBMIT", "NAVIGATE"],
    urls: ["http://127.0.0.1:4010/login", "http://127.0.0.1:4010/dashboard"],
    targets: ['button("Sign in")', 'form("Username Password Sign in")', 'input("credentials")'],
    endState: { finalUrl: "http://127.0.0.1:4010/dashboard", title: "Dashboard", heading: "Dashboard", alertText: null },
  },
  {
    name: "reports",
    canonical: ["NAVIGATE", "INPUT", "CHANGE", "INPUT", "CHANGE", "CLICK", "SUBMIT", "NAVIGATE", "CLICK", "NAVIGATE"],
    urls: ["http://127.0.0.1:4010/login", "http://127.0.0.1:4010/dashboard", "http://127.0.0.1:4010/reports"],
    targets: ['button("Sign in")', 'a("Open reports")', 'input("credentials")'],
    endState: { finalUrl: "http://127.0.0.1:4010/reports", title: "Reports", heading: "Reports", alertText: null },
  },
  {
    name: "settings",
    canonical: ["NAVIGATE", "INPUT", "CHANGE", "INPUT", "CHANGE", "CLICK", "SUBMIT", "NAVIGATE", "CLICK", "NAVIGATE"],
    urls: ["http://127.0.0.1:4010/login", "http://127.0.0.1:4010/dashboard", "http://127.0.0.1:4010/settings"],
    targets: ['button("Sign in")', 'a("Open settings")', 'input("credentials")'],
    endState: { finalUrl: "http://127.0.0.1:4010/settings", title: "Settings", heading: "Settings", alertText: null },
  },
  {
    name: "search-results",
    canonical: ["NAVIGATE", "INPUT", "CHANGE", "INPUT", "CHANGE", "CLICK", "SUBMIT", "NAVIGATE", "CLICK", "NAVIGATE", "INPUT", "CHANGE", "CLICK", "SUBMIT", "NAVIGATE"],
    urls: ["http://127.0.0.1:4010/login", "http://127.0.0.1:4010/dashboard", "http://127.0.0.1:4010/search", "http://127.0.0.1:4010/search/results?q=wdyt"],
    targets: ['button("Sign in")', 'a("Open search")', 'button("Search")', 'input("search query")'],
    endState: { finalUrl: "http://127.0.0.1:4010/search/results?q=wdyt", title: "Search Results", heading: "Search Results", alertText: null },
  },
  {
    name: "search-empty",
    canonical: ["NAVIGATE", "INPUT", "CHANGE", "INPUT", "CHANGE", "CLICK", "SUBMIT", "NAVIGATE", "CLICK", "NAVIGATE", "INPUT", "CHANGE", "CLICK", "SUBMIT", "NAVIGATE"],
    urls: ["http://127.0.0.1:4010/login", "http://127.0.0.1:4010/dashboard", "http://127.0.0.1:4010/search", "http://127.0.0.1:4010/search/empty?q=empty"],
    targets: ['button("Sign in")', 'a("Open search")', 'button("Search")', 'input("search query")'],
    endState: { finalUrl: "http://127.0.0.1:4010/search/empty?q=empty", title: "No Results", heading: "No Results", alertText: null },
  },
  {
    name: "workspace-details",
    canonical: ["NAVIGATE", "INPUT", "CHANGE", "INPUT", "CHANGE", "CLICK", "SUBMIT", "NAVIGATE", "CLICK", "NAVIGATE", "CLICK", "NAVIGATE", "CLICK", "NAVIGATE"],
    urls: ["http://127.0.0.1:4010/login", "http://127.0.0.1:4010/dashboard", "http://127.0.0.1:4010/workspace", "http://127.0.0.1:4010/workspace/details"],
    targets: ['button("Sign in")', 'a("Workspace")', 'button("Details")', 'input("credentials")'],
    endState: { finalUrl: "http://127.0.0.1:4010/workspace/details", title: "Workspace", heading: "Workspace", alertText: null },
  },
  {
    name: "logout",
    canonical: ["NAVIGATE", "INPUT", "CHANGE", "INPUT", "CHANGE", "CLICK", "SUBMIT", "NAVIGATE", "CLICK", "NAVIGATE"],
    urls: ["http://127.0.0.1:4010/login", "http://127.0.0.1:4010/dashboard"],
    targets: ['button("Sign in")', 'a("Sign out")', 'input("credentials")'],
    endState: { finalUrl: "http://127.0.0.1:4010/login", title: "Demo Login", heading: "Sign in", alertText: null },
  },
  {
    name: "invalid-login",
    canonical: ["NAVIGATE", "INPUT", "CHANGE", "INPUT", "CHANGE", "CLICK", "SUBMIT", "NAVIGATE"],
    urls: ["http://127.0.0.1:4010/login"],
    targets: ['button("Sign in")', 'form("Username Password Sign in")', 'input("credentials")'],
    endState: { finalUrl: "http://127.0.0.1:4010/login", title: "Demo Login", heading: "Sign in", alertText: "Invalid username or password." },
  },
];

function hashFlowId(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function toEvents(scenario: SyntheticScenario, runIndex: number) {
  const events: IngestPayload["events"] = [];
  let ts = 1_000 + runIndex * 100;
  let seq = 1;

  for (const url of scenario.urls) {
    events.push({ type: "navigate", ts, seq, url });
    ts += 10;
    seq += 1;
  }

  for (const target of scenario.targets) {
    const [, tag = "div", text = ""] = target.match(/^([a-z]+)\("?(.*?)"?\)$/i) ?? [];
    events.push({
      type: target.includes("input(") ? "input" : "click",
      ts,
      seq,
      target: { tag, text: text || null },
    });
    ts += 10;
    seq += 1;
  }

  events.push({ type: "submit", ts, seq });
  return events;
}

function buildSyntheticRun(unitIndex: number, runIndex: number, scenario: SyntheticScenario) {
  const suiteName = unitIndex % 2 === 0 ? "synthetic/playwright" : "synthetic/selenium";
  const tool = unitIndex % 2 === 0 ? "playwright" : "selenium";
  const browserVersion = unitIndex % 2 === 0 ? "147.0.0.0" : "149.0.0.0";
  const runId = `synthetic-run-${unitIndex}-${runIndex}`;
  const flowSeed = `${scenario.name}:${unitIndex}`;
  const flowId = hashFlowId(flowSeed);
  const rawRun: IngestPayload = {
    suite: {
      id: `synthetic-suite-${suiteName.replaceAll("/", "-")}`,
      name: suiteName,
      normalizedName: suiteName.toLowerCase(),
    },
    run: {
      id: runId,
      testName: `${scenario.name}-${unitIndex}`,
      startedAt: Date.now() + unitIndex * 1_000 + runIndex * 100,
      endedAt: Date.now() + unitIndex * 1_000 + runIndex * 100 + 90,
      reason: "completed",
    },
    environment: {
      tool,
      browser: {
        family: "chromium",
        version: browserVersion,
        source: "bootstrap-request",
      },
    },
    endState: scenario.endState,
    events: toEvents(scenario, runIndex),
  };

  const processedRun: ProcessedRunRecord = {
    runId,
    suite: rawRun.suite,
    environment: rawRun.environment,
    endState: rawRun.endState,
    reduced: scenario.canonical,
    canonical: scenario.canonical,
    flowId,
    meta: {
      canonicalSource: "reducer",
    },
  };

  return { rawRun, processedRun };
}

export async function resetSyntheticRuntimeData() {
  await ensureDataDir();
  await writeJsonFile(getReviewUnitsPath(), []);
  await writeJsonFile(getVocabularyPath(), []);
  await writeJsonFile(getCriticalFlowsPath(), []);
  await writeFile(getRawRunsPath(), "", "utf8");
  await writeFile(getProcessedRunsPath(), "", "utf8");
}

export async function seedSyntheticRuntimeData(options: SyntheticSeedOptions) {
  const units = Math.max(1, Math.floor(options.units));
  const runsPerUnit = Math.max(1, Math.floor(options.runsPerUnit));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));

  await resetSyntheticRuntimeData();

  for (let unitIndex = 0; unitIndex < units; unitIndex += 1) {
    const syntheticIndex = offset + unitIndex;
    const scenario = SCENARIOS[syntheticIndex % SCENARIOS.length];
    for (let runIndex = 0; runIndex < runsPerUnit; runIndex += 1) {
      const run = buildSyntheticRun(syntheticIndex, runIndex, scenario);
      await appendJsonLine(getRawRunsPath(), run.rawRun);
      await appendJsonLine(getProcessedRunsPath(), run.processedRun);
    }
  }

  return {
    units,
    runsPerUnit,
    totalRuns: units * runsPerUnit,
  };
}
