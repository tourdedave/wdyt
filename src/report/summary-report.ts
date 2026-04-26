import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadCriticalFlowState } from "../server/critical-flows.js";
import { loadReviewUnits } from "../server/review.js";
import type { CriticalFlowDetailRecord, ReviewUnitRecord } from "../shared/types.js";

export type SummaryReportData = {
  title: string;
  subtitle: string;
  executiveSummary: string;
  observedBehaviors: Array<{
    title: string;
    count: number;
  }>;
  expectedBehaviors: CriticalFlowDetailRecord[];
};

type PdfRenderMode = "puppeteer" | "stub";

function escapeHtml(value: unknown) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function getActiveUnits(units: ReviewUnitRecord[]) {
  return units.filter((unit) => unit.proposalState === "proposed" && (unit.activeDescriptor || unit.proposedDescriptor));
}

function getOverlapVocab(unit: ReviewUnitRecord) {
  return Array.isArray(unit.overlapTerms) ? unit.overlapTerms : [];
}

function getDescriptorKey(unit: ReviewUnitRecord) {
  return String(unit.activeDescriptor || unit.proposedDescriptor || "").trim().toLowerCase();
}

function getSharedOverlapCount(leftValues: string[], rightValues: string[]) {
  const right = new Set((rightValues || []).map((value) => String(value).trim()).filter(Boolean));
  return (leftValues || []).filter((value) => right.has(String(value).trim())).length;
}

function isOverlapMatch(leftValues: string[], rightValues: string[]) {
  const left = (leftValues || []).map((value) => String(value).trim()).filter(Boolean);
  const right = (rightValues || []).map((value) => String(value).trim()).filter(Boolean);
  const shared = getSharedOverlapCount(left, right);
  const maxCount = Math.max(left.length, right.length);
  if (maxCount === 0) {
    return false;
  }
  if (shared >= 2 && shared / maxCount >= 0.67) {
    return true;
  }
  return maxCount <= 2 && shared === maxCount && maxCount > 0;
}

function isSubsetOverlapMatch(leftUnit: ReviewUnitRecord, rightUnit: ReviewUnitRecord) {
  const leftDescriptor = getDescriptorKey(leftUnit);
  const rightDescriptor = getDescriptorKey(rightUnit);
  if (!leftDescriptor || leftDescriptor !== rightDescriptor) {
    return false;
  }

  const left = getOverlapVocab(leftUnit);
  const right = getOverlapVocab(rightUnit);
  const shared = getSharedOverlapCount(left, right);
  const minCount = Math.min(left.length, right.length);
  return minCount > 0 && shared === minCount;
}

function getOverlapGroups(units: ReviewUnitRecord[]) {
  const groups: Array<{
    key: string;
    vocab: string[];
    units: ReviewUnitRecord[];
  }> = [];

  getActiveUnits(units)
    .slice()
    .sort((a, b) => getOverlapVocab(a).length - getOverlapVocab(b).length || a.reviewId.localeCompare(b.reviewId))
    .forEach((unit) => {
      const vocab = getOverlapVocab(unit);
      if (vocab.length === 0) {
        return;
      }

      const matchedGroup = groups.find((group) =>
        group.units.some((candidate) => isOverlapMatch(vocab, getOverlapVocab(candidate)) || isSubsetOverlapMatch(unit, candidate))
      );

      if (matchedGroup) {
        matchedGroup.units.push(unit);
        matchedGroup.vocab = [...new Set([...matchedGroup.vocab, ...vocab])].sort();
        matchedGroup.key = matchedGroup.vocab.join("||");
        return;
      }

      groups.push({
        key: [...vocab].sort().join("||"),
        vocab: [...vocab],
        units: [unit],
      });
    });

  return groups
    .filter((group) => group.units.length > 1)
    .sort((a, b) => b.units.length - a.units.length || a.vocab.join(" ").localeCompare(b.vocab.join(" ")));
}

function getOverlapTitle(group: { units: ReviewUnitRecord[]; vocab: string[] }) {
  const descriptors = group.units
    .map((unit) => String(unit.activeDescriptor || unit.proposedDescriptor || unit.canonical.join(" → ")).trim())
    .filter(Boolean);
  if (descriptors.length === 0) {
    return group.vocab.join(" + ");
  }

  const counts = new Map<string, number>();
  descriptors.forEach((descriptor) => {
    counts.set(descriptor, (counts.get(descriptor) || 0) + 1);
  });

  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0][0];
}

function getUniqueFlows(units: ReviewUnitRecord[]) {
  const overlapGroups = getOverlapGroups(units);
  const clusteredIds = new Set(overlapGroups.flatMap((group) => group.units.map((unit) => unit.reviewId)));
  const representatives = overlapGroups.map((group) => ({
    title: getOverlapTitle(group),
    count: group.units.length,
  }));
  const singletons = getActiveUnits(units)
    .filter((unit) => !clusteredIds.has(unit.reviewId))
    .map((unit) => ({
      title: unit.activeDescriptor || unit.proposedDescriptor || unit.canonical.join(" → "),
      count: 1,
    }));

  return [...representatives, ...singletons]
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .map((item) => ({
      title: item.title,
      count: item.count,
    }));
}

function formatCoverageLine(flow: CriticalFlowDetailRecord) {
  if (flow.status === "covered") {
    return `${flow.name} — Covered`;
  }

  if (flow.status === "missing") {
    return `${flow.name} — Missing (no test evidence found)`;
  }

  if (Array.isArray(flow.missingTerms) && flow.missingTerms.length > 0) {
    return `${flow.name} — Partial (missing: ${flow.missingTerms.join(", ")})`;
  }

  return `${flow.name} — Partial`;
}

function formatCoverageSummary(flows: CriticalFlowDetailRecord[]) {
  const covered = flows.filter((flow) => flow.status === "covered").length;
  const partial = flows.filter((flow) => flow.status === "partial").length;
  const missing = flows.filter((flow) => flow.status === "missing").length;
  const parts = [
    covered > 0 ? `${covered} covered` : "",
    partial > 0 ? `${partial} partial` : "",
    missing > 0 ? `${missing} missing` : "",
  ].filter(Boolean);

  if (parts.length === 0) {
    return "";
  }
  if (parts.length === 1) {
    return `Coverage shows ${parts[0]}.`;
  }
  if (parts.length === 2) {
    return `Coverage shows ${parts[0]} and ${parts[1]}.`;
  }
  return `Coverage shows ${parts[0]}, ${parts[1]}, and ${parts[2]}.`;
}

export async function loadSummaryReportData(): Promise<SummaryReportData> {
  const [units, criticalFlowState] = await Promise.all([loadReviewUnits(), loadCriticalFlowState()]);
  const observedBehaviors = getUniqueFlows(units);
  const expectedBehaviors = (criticalFlowState.flows || []).slice().sort((a, b) => a.name.localeCompare(b.name));

  if (observedBehaviors.length === 0 && expectedBehaviors.length === 0) {
    throw new Error("No wdyt data available for report export.");
  }

  const coverageSummary = expectedBehaviors.length > 0 ? ` ${formatCoverageSummary(expectedBehaviors)}` : "";

  return {
    title: "What Did You Test?",
    subtitle: "Test Execution Summary",
    executiveSummary: `This run exercised ${observedBehaviors.length} distinct behaviors.${coverageSummary}`.trim(),
    observedBehaviors,
    expectedBehaviors,
  };
}

export function buildReportHtml(data: SummaryReportData) {
  const observedBehaviorItems = data.observedBehaviors
    .map((item) => `<li>${escapeHtml(item.count > 1 ? `${item.title} (${item.count})` : item.title)}</li>`)
    .join("");

  const expectedBehaviorItems = data.expectedBehaviors
    .map((flow) => `<li>${escapeHtml(formatCoverageLine(flow))}</li>`)
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(data.title)} | ${escapeHtml(data.subtitle)}</title>
    <style>
      :root {
        color-scheme: light;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        padding: 0;
        background: #ffffff;
        color: #111111;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        max-width: 760px;
        margin: 0 auto;
        padding: 8px 0;
      }
      h1 {
        margin: 0;
        font-size: 28px;
        line-height: 1.15;
      }
      .subtitle {
        margin: 8px 0 0;
        color: #5f6368;
        font-size: 15px;
      }
      .summary {
        margin: 24px 0 0;
        font-size: 16px;
        line-height: 1.6;
      }
      section {
        margin-top: 30px;
      }
      h2 {
        margin: 0 0 12px;
        font-size: 18px;
        line-height: 1.3;
      }
      ul {
        margin: 0;
        padding-left: 22px;
      }
      li {
        margin: 0 0 8px;
        line-height: 1.5;
      }
      li:last-child {
        margin-bottom: 0;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>${escapeHtml(data.title)}</h1>
        <p class="subtitle">${escapeHtml(data.subtitle)}</p>
      </header>
      <p class="summary">${escapeHtml(data.executiveSummary)}</p>
      <section>
        <h2>Observed Behaviors</h2>
        <ul>${observedBehaviorItems}</ul>
      </section>
      ${data.expectedBehaviors.length > 0 ? `
      <section>
        <h2>Coverage Against Expected Behaviors</h2>
        <ul>${expectedBehaviorItems}</ul>
      </section>` : ""}
    </main>
  </body>
</html>`;
}

export async function renderReportPdf(data: SummaryReportData, options?: { mode?: PdfRenderMode }) {
  const html = buildReportHtml(data);
  const mode = options?.mode ?? "puppeteer";

  if (mode === "stub") {
    return Buffer.from(`%PDF-STUB\n${html}`, "utf8");
  }

  let puppeteerModule: { default?: { launch?: (options?: unknown) => Promise<any> }; launch?: (options?: unknown) => Promise<any> };
  try {
    puppeteerModule = await import("puppeteer");
  } catch (error) {
    throw new Error("PDF export requires the 'puppeteer' package to be installed.");
  }

  const puppeteer = puppeteerModule.default?.launch ? puppeteerModule.default : puppeteerModule;
  if (!puppeteer.launch) {
    throw new Error("PDF export requires a Puppeteer build with launch() support.");
  }
  const browser = await puppeteer.launch();

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.emulateMediaType("screen");
    return Buffer.from(
      await page.pdf({
        format: "A4",
        printBackground: true,
        margin: {
          top: "40px",
          right: "40px",
          bottom: "40px",
          left: "40px",
        },
      })
    );
  } finally {
    await browser.close();
  }
}

export async function exportPdf(data: SummaryReportData, outputPath: string, options?: { mode?: PdfRenderMode }) {
  const absolutePath = path.resolve(process.cwd(), outputPath);
  const pdfBuffer = await renderReportPdf(data, options);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, pdfBuffer);
  return absolutePath;
}
