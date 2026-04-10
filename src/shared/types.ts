export type WditEventType = "click" | "input" | "change" | "submit" | "navigate";

export type WditEvent = {
  type: WditEventType;
  ts: number;
  seq: number;
  url?: string;
  target?: {
    tag: string;
    text: string | null;
  };
};

export type SuiteInfo = {
  id: string;
  name: string;
  normalizedName: string;
};

export type RunInfo = {
  id: string;
  testName: string;
  startedAt: number;
  endedAt: number;
  reason: "completed" | "timeout";
};

export type StartRunRequest = {
  suiteName: string;
  testName: string;
};

export type StartRunResponse = {
  runId: string;
  bootstrapUrl: string;
};

export type EndRunRequest = {
  runId: string;
  reason?: "completed" | "timeout";
};

export type IngestPayload = {
  suite: SuiteInfo;
  run: RunInfo;
  events: WditEvent[];
};

export type ReducedStep = "CLICK" | "INPUT" | "CHANGE" | "SUBMIT" | "NAVIGATE";

export type ProcessedRunRecord = {
  runId: string;
  suite: SuiteInfo;
  reduced: ReducedStep[];
  canonical: ReducedStep[];
  flowId: string;
  meta: {
    canonicalSource: "reducer";
  };
};
