import { randomUUID } from "node:crypto";

import { createSuiteInfo } from "../shared/naming.js";
import type { RunInfo, SuiteInfo } from "../shared/types.js";

export type RunStatus = "created" | "bound" | "ending" | "ingested";

export type RunRecord = {
  suite: SuiteInfo;
  run: {
    id: string;
    testName: string;
    startedAt: number;
  };
  status: RunStatus;
  boundBrowserSessionId: string | null;
  endReason: "completed" | "timeout" | null;
  endedAt: number | null;
};

const runsById = new Map<string, RunRecord>();
const runIdByBrowserSessionId = new Map<string, string>();

export function startRun(input: { suiteName: string; testName: string }) {
  const runId = randomUUID();
  const startedAt = Date.now();

  const record: RunRecord = {
    suite: createSuiteInfo(input.suiteName),
    run: {
      id: runId,
      testName: input.testName,
      startedAt,
    },
    status: "created",
    boundBrowserSessionId: null,
    endReason: null,
    endedAt: null,
  };

  runsById.set(runId, record);

  return {
    runId,
  };
}

export function bindRun(input: { runId: string; browserSessionId: string }) {
  const record = runsById.get(input.runId);

  if (!record || record.status === "ingested") {
    return null;
  }

  const existingRunId = runIdByBrowserSessionId.get(input.browserSessionId);

  if (existingRunId && existingRunId !== input.runId) {
    const existingRecord = runsById.get(existingRunId);

    if (existingRecord && existingRecord.status !== "ingested") {
      throw new Error("Browser session is already bound to another active run");
    }
  }

  record.status = record.status === "ending" ? "ending" : "bound";
  record.boundBrowserSessionId = input.browserSessionId;
  runIdByBrowserSessionId.set(input.browserSessionId, input.runId);

  return {
    suite: record.suite,
    run: record.run,
    status: record.status,
    endReason: record.endReason,
  };
}

export function getBoundRun(browserSessionId: string) {
  const runId = runIdByBrowserSessionId.get(browserSessionId);

  if (!runId) {
    return null;
  }

  const record = runsById.get(runId);

  if (!record || record.status === "ingested") {
    runIdByBrowserSessionId.delete(browserSessionId);
    return null;
  }

  return {
    suite: record.suite,
    run: record.run,
    status: record.status,
    endReason: record.endReason,
  };
}

export function requestRunEnd(input: { runId: string; reason: "completed" | "timeout" }) {
  const record = runsById.get(input.runId);

  if (!record) {
    return null;
  }

  record.status = "ending";
  record.endReason = input.reason;
  record.endedAt = Date.now();

  return {
    ok: true,
  };
}

export function buildRunInfoForIngest(runId: string, fallbackEndedAt: number, fallbackReason: "completed" | "timeout"): RunInfo | null {
  const record = runsById.get(runId);

  if (!record) {
    return null;
  }

  return {
    id: record.run.id,
    testName: record.run.testName,
    startedAt: record.run.startedAt,
    endedAt: record.endedAt ?? fallbackEndedAt,
    reason: record.endReason ?? fallbackReason,
  };
}

export function markRunIngested(runId: string, endedAt: number, reason: "completed" | "timeout") {
  const record = runsById.get(runId);

  if (!record) {
    return;
  }

  record.status = "ingested";
  record.endReason = reason;
  record.endedAt = endedAt;

  if (record.boundBrowserSessionId) {
    runIdByBrowserSessionId.delete(record.boundBrowserSessionId);
  }

}
