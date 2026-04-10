#!/usr/bin/env node
import { getProcessedRunsPath, getRawRunsPath, readJsonLines } from "../shared/fs.js";
import type { IngestPayload, ProcessedRunRecord } from "../shared/types.js";

function formatFlow(steps: string[]) {
  return steps.join(" \u2192 ");
}

function summarizeList(values: string[]) {
  if (values.length === 0) {
    return "-";
  }

  if (values.length <= 2) {
    return values.join(", ");
  }

  return `${values[0]}, ${values[1]} +${values.length - 2}`;
}

function formatBrowser(value: ProcessedRunRecord["environment"] | undefined) {
  const browser = value?.browser;

  if (!browser) {
    return "-";
  }

  return `${browser.family} ${browser.version}`;
}

function pad(value: string, width: number) {
  if (value.length >= width) {
    return value;
  }

  return value.padEnd(width, " ");
}

function truncate(value: string, width: number) {
  if (value.length <= width) {
    return value;
  }

  if (width <= 1) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 1)}…`;
}

async function printFlows() {
  const records = await readJsonLines<ProcessedRunRecord>(getProcessedRunsPath());
  const rawRuns = await readJsonLines<IngestPayload>(getRawRunsPath());
  const rawRunById = new Map(rawRuns.map((run) => [run.run.id, run]));
  const groups = new Map<
    string,
    {
      count: number;
      canonical: string[];
      suites: Set<string>;
      tests: Set<string>;
      browsers: Set<string>;
    }
  >();

  for (const record of records) {
    const rawRun = rawRunById.get(record.runId);
    const current = groups.get(record.flowId);

    if (current) {
      current.count += 1;
      current.suites.add(record.suite.name);
      if (rawRun?.run.testName) {
        current.tests.add(rawRun.run.testName);
      }
      current.browsers.add(formatBrowser(record.environment));
      continue;
    }

    groups.set(record.flowId, {
      count: 1,
      canonical: record.canonical,
      suites: new Set([record.suite.name]),
      tests: new Set(rawRun?.run.testName ? [rawRun.run.testName] : []),
      browsers: new Set([formatBrowser(record.environment)]),
    });
  }

  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);

  if (sorted.length === 0) {
    console.log("No flows found.");
    return;
  }

  const headers = {
    count: "Count",
    suites: "Suites",
    tests: "Tests",
    browser: "Browser",
    flow: "Flow",
  };

  const rows = sorted.map((flow) => {
    return {
      count: String(flow.count),
      suites: summarizeList([...flow.suites].sort()),
      tests: summarizeList([...flow.tests].sort()),
      browser: summarizeList([...flow.browsers].filter((value) => value !== "-").sort()),
      flow: formatFlow(flow.canonical),
    };
  });

  const widths = {
    count: Math.max(headers.count.length, ...rows.map((row) => row.count.length)),
    suites: Math.max(headers.suites.length, ...rows.map((row) => row.suites.length)),
    tests: Math.max(headers.tests.length, ...rows.map((row) => row.tests.length)),
    browser: Math.max(headers.browser.length, ...rows.map((row) => row.browser.length)),
  };

  console.log(
    [
      pad(headers.count, widths.count),
      pad(headers.suites, widths.suites),
      pad(headers.tests, widths.tests),
      pad(headers.browser, widths.browser),
      headers.flow,
    ].join("  ")
  );

  for (const row of rows) {
    console.log(
      [
        pad(row.count, widths.count),
        pad(truncate(row.suites, widths.suites), widths.suites),
        pad(truncate(row.tests, widths.tests), widths.tests),
        pad(truncate(row.browser, widths.browser), widths.browser),
        row.flow,
      ].join("  ")
    );
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
