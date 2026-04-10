#!/usr/bin/env node
import { getProcessedRunsPath, readJsonLines } from "../shared/fs.js";
import type { ProcessedRunRecord } from "../shared/types.js";

function formatFlow(steps: string[]) {
  return steps.join(" \u2192 ");
}

async function printFlows() {
  const records = await readJsonLines<ProcessedRunRecord>(getProcessedRunsPath());
  const groups = new Map<
    string,
    {
      count: number;
      canonical: string[];
    }
  >();

  for (const record of records) {
    const current = groups.get(record.flowId);

    if (current) {
      current.count += 1;
      continue;
    }

    groups.set(record.flowId, {
      count: 1,
      canonical: record.canonical,
    });
  }

  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);

  for (const flow of sorted) {
    console.log(`${formatFlow(flow.canonical)} (${flow.count})`);
  }
}

async function main() {
  const [, , command] = process.argv;

  if (command === "flows") {
    await printFlows();
    return;
  }

  console.error("Usage: wdit flows");
  process.exitCode = 1;
}

await main();
