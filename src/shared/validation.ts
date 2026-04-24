import type { IngestPayload, WdytEvent } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidEvent(event: unknown): event is WdytEvent {
  if (!isPlainObject(event)) {
    return false;
  }

  const { type, ts, seq, url, target } = event;

  if (
    type !== "click" &&
    type !== "input" &&
    type !== "change" &&
    type !== "submit" &&
    type !== "navigate"
  ) {
    return false;
  }

  if (typeof ts !== "number" || !Number.isFinite(ts) || typeof seq !== "number") {
    return false;
  }

  if (type === "navigate") {
    return typeof url === "string" && url.length > 0;
  }

  return (
    isPlainObject(target) &&
    typeof target.tag === "string" &&
    (typeof target.text === "string" || target.text === null)
  );
}

export function validateIngestPayload(payload: unknown): payload is IngestPayload {
  if (!isPlainObject(payload)) {
    return false;
  }

  const { suite, run, events } = payload;

  if (!isPlainObject(suite) || !isPlainObject(run) || !Array.isArray(events)) {
    return false;
  }

  return (
    typeof suite.id === "string" &&
    typeof suite.name === "string" &&
    typeof suite.normalizedName === "string" &&
    (typeof run.id === "undefined" || typeof run.id === "string") &&
    typeof run.testName === "string" &&
    typeof run.startedAt === "number" &&
    typeof run.endedAt === "number" &&
    (run.reason === "completed" || run.reason === "timeout") &&
    events.every(isValidEvent)
  );
}
