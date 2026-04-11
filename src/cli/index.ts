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

function summarizeSamples(values: string[], max = 3) {
  if (values.length === 0) {
    return [];
  }

  return values.slice(0, max);
}

function truncateDetail(value: string, width = 120) {
  return truncate(value, width);
}

function formatBrowser(value: ProcessedRunRecord["environment"] | undefined) {
  const browser = value?.browser;

  if (!browser) {
    return "-";
  }

  return `${browser.family} ${browser.version}`;
}

function formatTool(value: ProcessedRunRecord["environment"] | undefined) {
  return value?.tool ?? "-";
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

async function printFlows(options: { verbose: boolean }) {
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
      tools: Set<string>;
      browsers: Set<string>;
      urls: Set<string>;
      targets: Set<string>;
      finalUrls: Set<string>;
      titles: Set<string>;
      headings: Set<string>;
      alerts: Set<string>;
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
      current.tools.add(formatTool(record.environment));
      current.browsers.add(formatBrowser(record.environment));
      for (const event of rawRun?.events ?? []) {
        if (event.type === "navigate" && event.url) {
          current.urls.add(event.url);
        }

        if (event.target?.tag) {
          const label = event.target.text ? `${event.target.tag}("${event.target.text}")` : event.target.tag;
          current.targets.add(label);
        }
      }
      if (record.endState?.finalUrl) {
        current.finalUrls.add(record.endState.finalUrl);
      }
      if (record.endState?.title) {
        current.titles.add(record.endState.title);
      }
      if (record.endState?.heading) {
        current.headings.add(record.endState.heading);
      }
      if (record.endState?.alertText) {
        current.alerts.add(record.endState.alertText);
      }
      continue;
    }

    const urls = new Set<string>();
    const targets = new Set<string>();
    const finalUrls = new Set<string>();
    const titles = new Set<string>();
    const headings = new Set<string>();
    const alerts = new Set<string>();

    for (const event of rawRun?.events ?? []) {
      if (event.type === "navigate" && event.url) {
        urls.add(event.url);
      }

      if (event.target?.tag) {
        const label = event.target.text ? `${event.target.tag}("${event.target.text}")` : event.target.tag;
        targets.add(label);
      }
    }

    if (record.endState?.finalUrl) {
      finalUrls.add(record.endState.finalUrl);
    }
    if (record.endState?.title) {
      titles.add(record.endState.title);
    }
    if (record.endState?.heading) {
      headings.add(record.endState.heading);
    }
    if (record.endState?.alertText) {
      alerts.add(record.endState.alertText);
    }

    groups.set(record.flowId, {
      count: 1,
      canonical: record.canonical,
      suites: new Set([record.suite.name]),
      tests: new Set(rawRun?.run.testName ? [rawRun.run.testName] : []),
      tools: new Set([formatTool(record.environment)]),
      browsers: new Set([formatBrowser(record.environment)]),
      urls,
      targets,
      finalUrls,
      titles,
      headings,
      alerts,
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
    tool: "Tool",
    browser: "Browser",
    flow: "Flow",
  };

  const rows = sorted.map((flow) => {
    return {
      count: String(flow.count),
      suites: summarizeList([...flow.suites].sort()),
      tests: summarizeList([...flow.tests].sort()),
      tool: summarizeList([...flow.tools].filter((value) => value !== "-").sort()),
      browser: summarizeList([...flow.browsers].filter((value) => value !== "-").sort()),
      flow: formatFlow(flow.canonical),
      urls: summarizeSamples([...flow.urls].sort()),
      targets: summarizeSamples([...flow.targets].sort()),
      finalUrls: summarizeSamples([...flow.finalUrls].sort()),
      titles: summarizeSamples([...flow.titles].sort()),
      headings: summarizeSamples([...flow.headings].sort()),
      alerts: summarizeSamples([...flow.alerts].sort()),
    };
  });

  const widths = {
    count: Math.max(headers.count.length, ...rows.map((row) => row.count.length)),
    suites: Math.max(headers.suites.length, ...rows.map((row) => row.suites.length)),
    tests: Math.max(headers.tests.length, ...rows.map((row) => row.tests.length)),
    tool: Math.max(headers.tool.length, ...rows.map((row) => row.tool.length)),
    browser: Math.max(headers.browser.length, ...rows.map((row) => row.browser.length)),
  };

  console.log(
    [
      pad(headers.count, widths.count),
      pad(headers.suites, widths.suites),
      pad(headers.tests, widths.tests),
      pad(headers.tool, widths.tool),
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
        pad(truncate(row.tool, widths.tool), widths.tool),
        pad(truncate(row.browser, widths.browser), widths.browser),
        row.flow,
      ].join("  ")
    );

    if (options.verbose) {
      console.log("  URLs:");
      if (row.urls.length === 0) {
        console.log("    - -");
      } else {
        for (const url of row.urls) {
          console.log(`    - ${truncateDetail(url)}`);
        }
      }

      console.log("  Final URLs:");
      if (row.finalUrls.length === 0) {
        console.log("    - -");
      } else {
        for (const url of row.finalUrls) {
          console.log(`    - ${truncateDetail(url)}`);
        }
      }

      console.log("  Titles:");
      if (row.titles.length === 0) {
        console.log("    - -");
      } else {
        for (const title of row.titles) {
          console.log(`    - ${truncateDetail(title)}`);
        }
      }

      console.log("  Headings:");
      if (row.headings.length === 0) {
        console.log("    - -");
      } else {
        for (const heading of row.headings) {
          console.log(`    - ${truncateDetail(heading)}`);
        }
      }

      console.log("  Alerts:");
      if (row.alerts.length === 0) {
        console.log("    - -");
      } else {
        for (const alert of row.alerts) {
          console.log(`    - ${truncateDetail(alert)}`);
        }
      }

      console.log("  Targets:");
      if (row.targets.length === 0) {
        console.log("    - -");
      } else {
        for (const target of row.targets) {
          console.log(`    - ${truncateDetail(target)}`);
        }
      }
      console.log("");
    }
  }
}

async function main() {
  const [, , command, ...args] = process.argv;

  if (command === "flows") {
    await printFlows({
      verbose: args.includes("--verbose"),
    });
    return;
  }

  console.error("Usage: wdit flows [--verbose]");
  process.exitCode = 1;
}

await main();
