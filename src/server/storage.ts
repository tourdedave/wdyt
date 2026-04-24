import { randomUUID } from "node:crypto";

import { appendJsonLine, getProcessedRunsPath, getRawRunsPath } from "../shared/fs.js";
import { buildFlowIdentity, reduceEvents } from "../shared/reducer.js";
import type { IngestPayload, ProcessedRunRecord } from "../shared/types.js";

export async function persistRun(payload: IngestPayload) {
  const runId = payload.run.id ?? randomUUID();
  const persistedPayload: IngestPayload = {
    ...payload,
    run: {
      ...payload.run,
      id: runId,
    },
  };

  await appendJsonLine(getRawRunsPath(), persistedPayload);

  const reduced = reduceEvents(persistedPayload.events);
  const identity = buildFlowIdentity(reduced);
  const processed: ProcessedRunRecord = {
    runId,
    suite: persistedPayload.suite,
    environment: persistedPayload.environment,
    endState: persistedPayload.endState,
    reduced,
    canonical: identity.canonical,
    flowId: identity.flowId,
    meta: {
      canonicalSource: "reducer",
    },
  };

  await appendJsonLine(getProcessedRunsPath(), processed);

  return processed;
}
