import { appendJsonLine, getProcessedRunsPath, getRawRunsPath } from "../shared/fs.js";
import { buildFlowIdentity, reduceEvents } from "../shared/reducer.js";
import type { IngestPayload, ProcessedRunRecord } from "../shared/types.js";

export async function persistRun(payload: IngestPayload) {
  await appendJsonLine(getRawRunsPath(), payload);

  const reduced = reduceEvents(payload.events);
  const identity = buildFlowIdentity(reduced);
  const processed: ProcessedRunRecord = {
    runId: payload.run.id,
    suite: payload.suite,
    environment: payload.environment,
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
