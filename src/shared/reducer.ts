import { createHash } from "node:crypto";

import type { ReducedStep, WdytEvent } from "./types.js";

const EVENT_TO_STEP: Record<WdytEvent["type"], ReducedStep> = {
  click: "CLICK",
  input: "INPUT",
  change: "CHANGE",
  submit: "SUBMIT",
  navigate: "NAVIGATE",
};

export function reduceEvents(events: WdytEvent[]): ReducedStep[] {
  const reduced: ReducedStep[] = [];

  for (const event of events) {
    const nextStep = EVENT_TO_STEP[event.type];
    const previous = reduced.at(-1);

    if (nextStep === "NAVIGATE") {
      reduced.push(nextStep);
      continue;
    }

    if (previous === nextStep) {
      continue;
    }

    reduced.push(nextStep);
  }

  return reduced;
}

export function buildFlowIdentity(steps: ReducedStep[]) {
  const canonical = [...steps];
  const signature = canonical.join("|");
  const flowId = createHash("sha256").update(signature).digest("hex").slice(0, 16);

  return {
    canonical,
    signature,
    flowId,
  };
}
