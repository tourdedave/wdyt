#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { DEFAULT_EXPORT_FILE_NAMES, exportArtifact } from "../artifact/exportArtifact.js";
import { importArtifacts } from "../artifact/importArtifact.js";
import { buildReviewUnits, queueProposalProcessing } from "../server/review.js";
import { seedSyntheticRuntimeData } from "../server/synthetic.js";
import {
  getProcessedRunsPath,
  getRawRunsPath,
  getReviewUnitsPath,
  getVocabularyPath,
  readJsonFile,
  readJsonLines,
  writeJsonFile,
} from "../shared/fs.js";
import type {
  FlowEvidenceItem,
  FlowTermCandidate,
  FlowRoleEvidence,
  FlowTermRole,
  FlowTermRoleClassification,
  IngestPayload,
  ResolvedFlowConcept,
  FlowDescriptorProposal,
  VocabStats,
  ProcessedRunRecord,
  ReviewUnitRecord,
  VocabularyEntry,
} from "../shared/types.js";
import { collectVocabStats, inferEvidenceTerms, inferSourceAwareTermCandidates, scoreFlowTermRoles } from "../shared/flow-suppression.js";
import { buildSemanticIndex, dedupeFlowTermCandidates } from "../shared/semantic-index.js";
import { resolveFlowConcepts, resolvedConceptsToCandidates, summarizeRoleEvidence } from "../shared/concept-resolver.js";
import { getDescriptorExcludedTerms, rebalanceClassifiedRoles } from "../shared/role-rebalance.js";
import {
  buildEvidenceCandidates,
  collectStructuredEvidenceItems,
  filterResolvedConcepts,
  normalizeConceptResolution,
  normalizeEvidenceClassification,
  partitionEvidenceItems,
} from "../shared/semantic-stages.js";
import {
  findApprovedVocabularyMatches,
  getApprovedVocabulary,
  normalizeProposedVocabulary,
  resolveApprovedVocabularyTerm,
} from "../shared/vocabulary.js";
import {
  buildFallbackDescriptor,
  buildProposalRetryFeedback,
  includesDescriptorExcludedTerm,
  isLowValueProposalTerm,
  normalizeDescriptorStyle,
  sanitizeDescriptorExcludedTerms,
  scoreProposalConfidence,
  validateProposal,
} from "../shared/proposal-validation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reviewSystemPromptPath = path.join(__dirname, "../prompts/review-system-prompt.txt");
const reviewTermRolePromptPath = path.join(__dirname, "../prompts/review-term-role-system-prompt.txt");
const reviewEvidenceClassificationPromptPath = path.join(__dirname, "../prompts/review-evidence-classification-system-prompt.txt");
const reviewConceptResolutionPromptPath = path.join(__dirname, "../prompts/review-concept-resolution-system-prompt.txt");
const DEFAULT_LLM_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_LLM_API_KEY = "ollama";
const DEFAULT_LLM_MODEL = "mistral:instruct";

type GroupedFlow = {
  flowId: string;
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
};

type ReviewUnit = GroupedFlow & {
  reviewId: string;
  variantSignature?: string;
};

type FlowRow = {
  flowId: string;
  count: string;
  suites: string;
  tests: string;
  tool: string;
  browser: string;
  flow: string;
  urls: string[];
  targets: string[];
  finalUrls: string[];
  titles: string[];
  headings: string[];
  alerts: string[];
};

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
  return values.slice(0, max);
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

function truncateDetail(value: string, width = 120) {
  return truncate(value, width);
}

function pad(value: string, width: number) {
  if (value.length >= width) {
    return value;
  }

  return value.padEnd(width, " ");
}

function formatBrowser(value: ProcessedRunRecord["environment"] | undefined) {
  const browser = value?.browser;
  return browser ? `${browser.family} ${browser.version}` : "-";
}

function formatTool(value: ProcessedRunRecord["environment"] | undefined) {
  return value?.tool ?? "-";
}

function extractTargetLabel(event: IngestPayload["events"][number]) {
  if (!event.target?.tag) {
    return null;
  }

  return event.target.text ? `${event.target.tag}("${event.target.text}")` : event.target.tag;
}

function buildProposedDescriptor(flow: GroupedFlow) {
  const alert = [...flow.alerts][0];
  if (alert) {
    return `Review login flow ending with alert: ${alert}`;
  }

  const heading = [...flow.headings][0];
  const finalUrl = [...flow.finalUrls][0];
  if (heading && finalUrl) {
    return `Review flow ending at ${heading} (${finalUrl})`;
  }

  if (heading) {
    return `Review flow ending at ${heading}`;
  }

  if (finalUrl) {
    return `Review flow ending at ${finalUrl}`;
  }

  return `Review flow: ${formatFlow(flow.canonical)}`;
}

function getVariantSignature(record: ProcessedRunRecord) {
  return JSON.stringify({
    finalUrl: record.endState?.finalUrl ?? null,
    title: record.endState?.title ?? null,
    heading: record.endState?.heading ?? null,
    alertText: record.endState?.alertText ?? null,
  });
}

function hashVariantSignature(signature: string) {
  return createHash("sha256").update(signature).digest("hex").slice(0, 12);
}

function clampConfidence(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function normalizeFlowDescriptorProposal(
  value: unknown,
  vocabulary: Iterable<VocabularyEntry>
): FlowDescriptorProposal | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const descriptor = typeof candidate.descriptor === "string" ? candidate.descriptor.trim() : "";
  const rationale = typeof candidate.rationale === "string" ? candidate.rationale.trim() : "";
  const approvedVocab = normalizeStringList(candidate.approvedVocab);
  const proposedVocab = normalizeStringList(candidate.proposedVocab);
  const confidence = clampConfidence(
    typeof candidate.confidence === "number" ? candidate.confidence : Number(candidate.confidence)
  );

  if (!descriptor || !rationale) {
    return null;
  }

  const approvedTerms = new Set<string>();
  for (const term of approvedVocab) {
    const canonicalTerm = resolveApprovedVocabularyTerm(term, vocabulary);
    if (canonicalTerm) {
      approvedTerms.add(canonicalTerm);
    }
  }

  const normalizedProposals = normalizeProposedVocabulary(proposedVocab, vocabulary);
  for (const term of normalizedProposals.approvedVocab) {
    approvedTerms.add(term);
  }

  return {
    descriptor,
    approvedVocab: [...approvedTerms].sort((a, b) => a.localeCompare(b)),
    proposedVocab: normalizedProposals.proposedVocab,
    confidence,
    rationale,
  };
}

function normalizeFlowTermRoleClassification(value: unknown, fallback: { prerequisiteTerms: string[]; primaryTerms: string[] }): FlowTermRoleClassification {
  if (!value || typeof value !== "object") {
    return {
      prerequisiteTerms: [...fallback.prerequisiteTerms],
      primaryTerms: [...fallback.primaryTerms],
      outcomeTerms: [],
      uncertainTerms: [],
    };
  }

  const candidate = value as Record<string, unknown>;
  const assignments = Array.isArray(candidate.termRoles) ? candidate.termRoles : [];
  const byRole = new Map<FlowTermRole, Set<string>>([
    ["prerequisite", new Set<string>()],
    ["primary", new Set<string>()],
    ["outcome", new Set<string>()],
    ["uncertain", new Set<string>()],
  ]);

  for (const assignment of assignments) {
    if (!assignment || typeof assignment !== "object") {
      continue;
    }
    const candidateAssignment = assignment as Record<string, unknown>;
    const role = candidateAssignment.role;
    const term = typeof candidateAssignment.term === "string"
      ? candidateAssignment.term.trim()
      : "";
    if (!term || (role !== "prerequisite" && role !== "primary" && role !== "outcome" && role !== "uncertain")) {
      continue;
    }
    byRole.get(role)?.add(term);
  }

  if ((byRole.get("primary")?.size ?? 0) === 0) {
    fallback.primaryTerms.forEach((term) => byRole.get("primary")?.add(term));
  }
  if ((byRole.get("prerequisite")?.size ?? 0) === 0) {
    fallback.prerequisiteTerms.forEach((term) => byRole.get("prerequisite")?.add(term));
  }

  const primaryTerms = [...(byRole.get("primary") ?? new Set<string>())].sort((a, b) => a.localeCompare(b));
  const prerequisiteTerms = [...(byRole.get("prerequisite") ?? new Set<string>())]
    .filter((term) => !primaryTerms.includes(term))
    .sort((a, b) => a.localeCompare(b));
  const outcomeTerms = [...(byRole.get("outcome") ?? new Set<string>())]
    .filter((term) => !primaryTerms.includes(term) && !prerequisiteTerms.includes(term))
    .sort((a, b) => a.localeCompare(b));
  const uncertainTerms = [...(byRole.get("uncertain") ?? new Set<string>())]
    .filter((term) => !primaryTerms.includes(term) && !prerequisiteTerms.includes(term) && !outcomeTerms.includes(term))
    .sort((a, b) => a.localeCompare(b));

  return { prerequisiteTerms, primaryTerms, outcomeTerms, uncertainTerms };
}

async function requestJsonCompletion(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
}) {
  const response = await fetch(new URL("chat/completions", `${input.baseUrl.replace(/\/?$/, "/")}`).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      response_format: { type: "json_object" },
      temperature: 0.2,
      stream: false,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM proposal failed with status ${response.status}: ${errorText}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };

  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM response did not include message content");
  }

  return JSON.parse(content) as unknown;
}

async function loadGroupedFlows() {
  const records = await readJsonLines<ProcessedRunRecord>(getProcessedRunsPath());
  const rawRuns = await readJsonLines<IngestPayload>(getRawRunsPath());
  const rawRunById = new Map(rawRuns.map((run) => [run.run.id, run]));
  const groups = new Map<string, GroupedFlow>();

  for (const record of records) {
    const rawRun = rawRunById.get(record.runId);
    const current = groups.get(record.flowId) ?? {
      flowId: record.flowId,
      count: 0,
      canonical: record.canonical,
      suites: new Set<string>(),
      tests: new Set<string>(),
      tools: new Set<string>(),
      browsers: new Set<string>(),
      urls: new Set<string>(),
      targets: new Set<string>(),
      finalUrls: new Set<string>(),
      titles: new Set<string>(),
      headings: new Set<string>(),
      alerts: new Set<string>(),
    };

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

      const targetLabel = extractTargetLabel(event);
      if (targetLabel) {
        current.targets.add(targetLabel);
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

    groups.set(record.flowId, current);
  }

  return [...groups.values()].sort((a, b) => b.count - a.count);
}

async function loadReviewUnits() {
  const records = await readJsonLines<ProcessedRunRecord>(getProcessedRunsPath());
  const rawRuns = await readJsonLines<IngestPayload>(getRawRunsPath());
  const rawRunById = new Map(rawRuns.map((run) => [run.run.id, run]));
  const recordsByFlow = new Map<string, ProcessedRunRecord[]>();

  for (const record of records) {
    const current = recordsByFlow.get(record.flowId) ?? [];
    current.push(record);
    recordsByFlow.set(record.flowId, current);
  }

  const reviewUnits: ReviewUnit[] = [];

  for (const [flowId, flowRecords] of recordsByFlow) {
    const variantGroups = new Map<string, ProcessedRunRecord[]>();

    for (const record of flowRecords) {
      const variantSignature = getVariantSignature(record);
      const current = variantGroups.get(variantSignature) ?? [];
      current.push(record);
      variantGroups.set(variantSignature, current);
    }

    const hasMultipleVariants = variantGroups.size > 1;

    for (const [variantSignature, variantRecords] of variantGroups) {
      const firstRecord = variantRecords[0];
      const unit: ReviewUnit = {
        reviewId: hasMultipleVariants ? `${flowId}:${hashVariantSignature(variantSignature)}` : flowId,
        flowId,
        variantSignature: hasMultipleVariants ? variantSignature : undefined,
        count: 0,
        canonical: firstRecord.canonical,
        suites: new Set<string>(),
        tests: new Set<string>(),
        tools: new Set<string>(),
        browsers: new Set<string>(),
        urls: new Set<string>(),
        targets: new Set<string>(),
        finalUrls: new Set<string>(),
        titles: new Set<string>(),
        headings: new Set<string>(),
        alerts: new Set<string>(),
      };

      for (const record of variantRecords) {
        const rawRun = rawRunById.get(record.runId);
        unit.count += 1;
        unit.suites.add(record.suite.name);
        if (rawRun?.run.testName) {
          unit.tests.add(rawRun.run.testName);
        }
        unit.tools.add(formatTool(record.environment));
        unit.browsers.add(formatBrowser(record.environment));

        for (const event of rawRun?.events ?? []) {
          if (event.type === "navigate" && event.url) {
            unit.urls.add(event.url);
          }

          const targetLabel = extractTargetLabel(event);
          if (targetLabel) {
            unit.targets.add(targetLabel);
          }
        }

        if (record.endState?.finalUrl) {
          unit.finalUrls.add(record.endState.finalUrl);
        }
        if (record.endState?.title) {
          unit.titles.add(record.endState.title);
        }
        if (record.endState?.heading) {
          unit.headings.add(record.endState.heading);
        }
        if (record.endState?.alertText) {
          unit.alerts.add(record.endState.alertText);
        }
      }

      reviewUnits.push(unit);
    }
  }

  return reviewUnits.sort((a, b) => b.count - a.count || a.reviewId.localeCompare(b.reviewId));
}

function toFlowRows(groupedFlows: GroupedFlow[]): FlowRow[] {
  return groupedFlows.map((flow) => ({
    flowId: flow.flowId,
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
  }));
}

function printFlowTable(rows: FlowRow[], options: { verbose: boolean }) {
  const headers = {
    count: "Count",
    suites: "Suites",
    tests: "Tests",
    tool: "Tool",
    browser: "Browser",
    flow: "Flow",
  };

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

    if (!options.verbose) {
      continue;
    }

    printDetailList("URLs", row.urls);
    printDetailList("Final URLs", row.finalUrls);
    printDetailList("Titles", row.titles);
    printDetailList("Headings", row.headings);
    printDetailList("Alerts", row.alerts);
    printDetailList("Targets", row.targets);
    console.log("");
  }
}

function printDetailList(label: string, values: string[]) {
  console.log(`  ${label}:`);
  if (values.length === 0) {
    console.log("    - -");
    return;
  }

  for (const value of values) {
    console.log(`    - ${truncateDetail(value)}`);
  }
}

async function printFlows(options: { verbose: boolean }) {
  const groupedFlows = await loadGroupedFlows();

  if (groupedFlows.length === 0) {
    console.log("No flows found.");
    return;
  }

  printFlowTable(toFlowRows(groupedFlows), options);
}

function sortStrings(values: string[]) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function materializeReviewUnitRecord(flow: ReviewUnit, existing?: ReviewUnitRecord): ReviewUnitRecord {
  const approvedVocabUsed = existing?.approvedVocabUsed ?? [];
  const proposedVocab = existing?.proposedVocab ?? [];
  const activeVocab = existing?.activeVocab ?? sortStrings([...approvedVocabUsed, ...proposedVocab]);

  return {
    reviewId: flow.reviewId,
    flowId: flow.flowId,
    variantSignature: flow.variantSignature,
    canonical: flow.canonical as ReviewUnitRecord["canonical"],
    count: flow.count,
    suites: [...flow.suites].sort(),
    tests: [...flow.tests].sort(),
    tools: [...flow.tools].sort(),
    browsers: [...flow.browsers].sort(),
    urls: [...flow.urls].sort(),
    targets: [...flow.targets].sort(),
    finalUrls: [...flow.finalUrls].sort(),
    titles: [...flow.titles].sort(),
    headings: [...flow.headings].sort(),
    alerts: [...flow.alerts].sort(),
    proposalState: existing?.proposalState ?? "pending",
    proposedDescriptor: existing?.proposedDescriptor,
    proposedConfidence: existing?.proposedConfidence,
    proposedRationale: existing?.proposedRationale,
    approvedVocabUsed,
    proposedVocab,
    activeDescriptor: existing?.activeDescriptor ?? existing?.proposedDescriptor,
    activeVocab,
    prerequisiteTerms: existing?.prerequisiteTerms,
    primaryTerms: existing?.primaryTerms,
    outcomeTerms: existing?.outcomeTerms,
    uncertainTerms: existing?.uncertainTerms,
    evidenceItems: existing?.evidenceItems,
    conceptResolutions: existing?.conceptResolutions,
    roleEvidence: existing?.roleEvidence,
    overlapTerms: existing?.overlapTerms,
    interpretationStatus: existing?.interpretationStatus,
    proposalError: existing?.proposalError,
    notes: existing?.notes,
    updatedAt: existing?.updatedAt ?? Date.now(),
    proposedAt: existing?.proposedAt,
    reprocessRequestedAt: existing?.reprocessRequestedAt,
  };
}

async function loadStoredReviewUnits() {
  const records = await readJsonFile<ReviewUnitRecord[]>(getReviewUnitsPath(), []);
  return new Map(records.map((record) => [record.reviewId, record]));
}

async function saveReviewUnits(units: Map<string, ReviewUnitRecord>) {
  await writeJsonFile(getReviewUnitsPath(), [...units.values()].sort((a, b) => a.reviewId.localeCompare(b.reviewId)));
}

async function loadVocabulary() {
  const entries = await readJsonFile<VocabularyEntry[]>(getVocabularyPath(), []);
  return new Map(entries.map((entry) => [entry.term, entry]));
}

async function saveVocabulary(vocabulary: Map<string, VocabularyEntry>) {
  await writeJsonFile(getVocabularyPath(), [...vocabulary.values()].sort((a, b) => a.term.localeCompare(b.term)));
}

function collectUsedVocab(descriptor: string, vocabulary: Map<string, VocabularyEntry>) {
  const normalizedDescriptor = descriptor.toLowerCase();
  return [...vocabulary.keys()]
    .filter((term) => normalizedDescriptor.includes(term.toLowerCase()))
    .sort();
}

function partitionTermCandidates(candidates: FlowTermCandidate[]) {
  const setupTerms = candidates.filter((candidate) => candidate.source === "setup").map((candidate) => candidate.term);
  const actionTerms = candidates.filter((candidate) => candidate.source === "action").map((candidate) => candidate.term);
  const endStateTerms = candidates.filter((candidate) => candidate.source === "end-state").map((candidate) => candidate.term);
  const registryTerms = candidates.filter((candidate) => candidate.source === "registry").map((candidate) => candidate.term);

  return {
    setupTerms: [...new Set(setupTerms)].sort((a, b) => a.localeCompare(b)),
    actionTerms: [...new Set(actionTerms)].sort((a, b) => a.localeCompare(b)),
    endStateTerms: [...new Set(endStateTerms)].sort((a, b) => a.localeCompare(b)),
    registryTerms: [...new Set(registryTerms)].sort((a, b) => a.localeCompare(b)),
  };
}

async function proposeDescriptor(
  flow: ReviewUnit,
  vocabulary: Map<string, VocabularyEntry>,
  stats: Map<string, VocabStats>,
  semanticIndex: ReturnType<typeof buildSemanticIndex>
) {
  const baseUrl = process.env.WDYT_LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL;
  const model = process.env.WDYT_LLM_MODEL ?? DEFAULT_LLM_MODEL;
  const apiKey = process.env.WDYT_LLM_API_KEY ?? DEFAULT_LLM_API_KEY;

  const systemPrompt = await readFile(reviewSystemPromptPath, "utf8");
  const roleSystemPrompt = await readFile(reviewTermRolePromptPath, "utf8");
  const evidenceClassificationSystemPrompt = await readFile(reviewEvidenceClassificationPromptPath, "utf8");
  const conceptResolutionSystemPrompt = await readFile(reviewConceptResolutionPromptPath, "utf8");
  const approvedVocabulary = getApprovedVocabulary(vocabulary.values())
    .map((entry) => ({
      term: entry.term,
      description: entry.description ?? null,
      aliases: entry.aliases ?? [],
    }));
  const registryMatches = findApprovedVocabularyMatches(
    [
      ...[...flow.urls].sort(),
      ...[...flow.finalUrls].sort(),
      ...[...flow.titles].sort(),
      ...[...flow.headings].sort(),
      ...[...flow.alerts].sort(),
      ...[...flow.targets].sort(),
      ...[...flow.tests].sort(),
    ],
    vocabulary.values()
  );
  const inferredFlowTerms = inferEvidenceTerms(
    [
      ...[...flow.urls].sort(),
      ...[...flow.finalUrls].sort(),
      ...[...flow.titles].sort(),
      ...[...flow.headings].sort(),
      ...[...flow.alerts].sort(),
      ...[...flow.targets].sort(),
    ],
    stats,
    vocabulary.values(),
    registryMatches
  );
  const rawEvidenceItems = collectStructuredEvidenceItems({
    setupUrls: [...[...flow.urls].filter((value) => !flow.finalUrls.has(value)).sort()],
    actionTargets: [...[...flow.targets].sort()],
    finalUrls: [...[...flow.finalUrls].sort()],
    titles: [...[...flow.titles].sort()],
    headings: [...[...flow.headings].sort()],
    alerts: [...[...flow.alerts].sort()],
  });
  const classifiedEvidenceItems = normalizeEvidenceClassification(
    await requestJsonCompletion({
      baseUrl,
      apiKey,
      model,
      systemPrompt: evidenceClassificationSystemPrompt,
      userPrompt: JSON.stringify(
        {
          reviewId: flow.reviewId,
          flowId: flow.flowId,
          canonical: flow.canonical,
          evidenceItems: rawEvidenceItems,
        },
        null,
        2
      ),
    }),
    rawEvidenceItems
  );
  const fallbackSourceCandidates = buildEvidenceCandidates(classifiedEvidenceItems, registryMatches, stats, vocabulary.values());
  const classifiedEvidenceBuckets = partitionEvidenceItems(classifiedEvidenceItems);
  const resolvedConcepts = filterResolvedConcepts(normalizeConceptResolution({
    value: await requestJsonCompletion({
      baseUrl,
      apiKey,
      model,
      systemPrompt: conceptResolutionSystemPrompt,
      userPrompt: JSON.stringify(
        {
          reviewId: flow.reviewId,
          flowId: flow.flowId,
          canonical: flow.canonical,
          evidenceItems: classifiedEvidenceItems,
          registryMatches,
          candidateConceptHints: [...new Set(fallbackSourceCandidates.map((candidate) => candidate.term))].sort((a, b) =>
            a.localeCompare(b)
          ),
          approvedVocabularyRegistry: approvedVocabulary,
        },
        null,
        2
      ),
    }),
    evidenceItems: classifiedEvidenceItems,
    fallbackCandidates: fallbackSourceCandidates,
    semanticIndex,
    vocabulary: vocabulary.values(),
  }));
  const resolvedCandidates = dedupeFlowTermCandidates(resolvedConceptsToCandidates(resolvedConcepts));
  const flowTerms = [...new Set([...inferredFlowTerms, ...resolvedConcepts.map((concept) => concept.term)])].sort((a, b) =>
    a.localeCompare(b)
  );
  const evidenceBuckets = partitionTermCandidates(resolvedCandidates);
  const roleHints = scoreFlowTermRoles(resolvedCandidates, stats, semanticIndex);
  const semanticNeighbors = Object.fromEntries(
    resolvedConcepts.map((concept) => [concept.term, concept.neighbors])
  );
  const roleEvidence = {
    reviewId: flow.reviewId,
    flowId: flow.flowId,
    canonical: flow.canonical,
    evidenceItems: classifiedEvidenceItems,
    flowTerms,
    setupTerms: evidenceBuckets.setupTerms,
    actionTerms: evidenceBuckets.actionTerms,
    endStateTerms: evidenceBuckets.endStateTerms,
    registryTerms: evidenceBuckets.registryTerms,
    setupEvidence: classifiedEvidenceBuckets.setupValues,
    actionEvidence: classifiedEvidenceBuckets.actionValues,
    endStateEvidence: classifiedEvidenceBuckets.endStateValues,
    semanticNeighbors,
    resolvedConcepts,
    heuristicPrerequisiteTerms: roleHints.prerequisiteTerms,
    heuristicPrimaryTerms: roleHints.primaryTerms,
    tests: [...flow.tests].sort(),
    urls: summarizeSamples([...flow.urls].sort(), 5),
    finalUrls: summarizeSamples([...flow.finalUrls].sort(), 5),
    titles: summarizeSamples([...flow.titles].sort(), 5),
    headings: summarizeSamples([...flow.headings].sort(), 5),
    alerts: summarizeSamples([...flow.alerts].sort(), 5),
    targets: summarizeSamples([...flow.targets].sort(), 5),
  };
  const classifiedTerms = rebalanceClassifiedRoles(
    normalizeFlowTermRoleClassification(
    await requestJsonCompletion({
      baseUrl,
      apiKey,
      model,
      systemPrompt: roleSystemPrompt,
      userPrompt: JSON.stringify(roleEvidence, null, 2),
    }),
    roleHints
    ),
    resolvedConcepts
  );
  const roleEvidenceSummary: FlowRoleEvidence = summarizeRoleEvidence({
    concepts: resolvedConcepts,
    prerequisiteTerms: classifiedTerms.prerequisiteTerms,
    primaryTerms: classifiedTerms.primaryTerms,
  });
  const descriptorExcludedTerms = getDescriptorExcludedTerms(flowTerms, classifiedTerms);
  const descriptorFocusTerms =
    classifiedTerms.primaryTerms.length > 0
      ? [...classifiedTerms.primaryTerms, ...classifiedTerms.outcomeTerms].sort((a, b) => a.localeCompare(b))
      : flowTerms;

  const evidence = {
    reviewId: flow.reviewId,
    flowId: flow.flowId,
    variantSignature: flow.variantSignature ?? null,
    canonical: flow.canonical,
    allFlowTerms: flowTerms,
    flowTerms: descriptorFocusTerms,
    prerequisiteTerms: classifiedTerms.prerequisiteTerms,
    primaryTerms: classifiedTerms.primaryTerms,
    outcomeTerms: classifiedTerms.outcomeTerms,
    uncertainTerms: classifiedTerms.uncertainTerms,
    descriptorExcludedTerms,
    count: flow.count,
    suites: [...flow.suites].sort(),
    tests: [...flow.tests].sort(),
    tools: [...flow.tools].filter((value) => value !== "-").sort(),
    browsers: [...flow.browsers].filter((value) => value !== "-").sort(),
    urls: summarizeSamples([...flow.urls].sort(), 5),
    finalUrls: summarizeSamples([...flow.finalUrls].sort(), 5),
    titles: summarizeSamples([...flow.titles].sort(), 5),
    headings: summarizeSamples([...flow.headings].sort(), 5),
    alerts: summarizeSamples([...flow.alerts].sort(), 5),
    targets: summarizeSamples([...flow.targets].sort(), 5),
    approvedVocabularyRegistry: approvedVocabulary,
    registryMatches,
  };
  const userPrompt = JSON.stringify(evidence, null, 2);

  async function generateProposal(retryReason?: string) {
    const parsed = normalizeFlowDescriptorProposal(
      await requestJsonCompletion({
        baseUrl,
        apiKey,
        model,
        systemPrompt,
        userPrompt: retryReason ? `${userPrompt}\n\nIMPORTANT RETRY INSTRUCTION:\n${retryReason}` : userPrompt,
      }),
      vocabulary.values()
    );

    if (!parsed) {
      throw new Error("LLM response did not match expected proposal schema");
    }

    return parsed;
  }

  let parsed = await generateProposal();
  let validation = validateProposal(evidence, parsed, vocabulary.values());
  const retryFeedback = buildProposalRetryFeedback(validation.issues);
  if (retryFeedback) {
    parsed = await generateProposal(retryFeedback);
    validation = validateProposal(evidence, parsed, vocabulary.values());
  }
  if (validation.issues.some((issue) => issue.includes("The descriptor includes descriptor-excluded terms."))) {
    parsed = {
      ...parsed,
      descriptor: sanitizeDescriptorExcludedTerms(parsed.descriptor, descriptorExcludedTerms),
    };
    validation = validateProposal(evidence, parsed, vocabulary.values());
  }
  if (
    validation.issues.some((issue) =>
      issue.includes("low-level UI mechanics") || issue.includes("unsupported success or mutation claim")
    )
  ) {
    parsed = {
      ...parsed,
      descriptor: buildFallbackDescriptor(evidence),
    };
    validation = validateProposal(evidence, parsed, vocabulary.values());
  }
  parsed = {
    ...parsed,
    descriptor: normalizeDescriptorStyle(parsed.descriptor),
  };
  validation = validateProposal(evidence, parsed, vocabulary.values());
  const filteredApprovedVocab = descriptorExcludedTerms.length > 0
    ? parsed.approvedVocab.filter((term) => !includesDescriptorExcludedTerm(term, descriptorExcludedTerms))
    : parsed.approvedVocab;
  const filteredProposedVocab = parsed.proposedVocab.filter((term) =>
    !isLowValueProposalTerm(term) && !includesDescriptorExcludedTerm(term, descriptorExcludedTerms)
  );

  return {
    descriptor: parsed.descriptor,
    approvedVocab: filteredApprovedVocab,
    proposedVocab: filteredProposedVocab,
    confidence: scoreProposalConfidence(evidence, parsed, validation.issues),
    rationale: parsed.rationale,
    conceptResolutions: resolvedConcepts as ResolvedFlowConcept[],
    roleEvidence: roleEvidenceSummary as FlowRoleEvidence,
  };
}

async function reviewFlows(options: { propose: boolean }) {
  const reviewUnits = await loadReviewUnits();
  if (reviewUnits.length === 0) {
    console.log("No flows found.");
    return;
  }

  const storedReviewUnits = await loadStoredReviewUnits();
  const reviewRecords = new Map(
    reviewUnits.map((flow) => [flow.reviewId, materializeReviewUnitRecord(flow, storedReviewUnits.get(flow.reviewId))])
  );
  const vocabulary = await loadVocabulary();
  const suppressionStats = collectVocabStats(
    reviewUnits.map((flow) => ({
      activeDescriptor: reviewRecords.get(flow.reviewId)?.activeDescriptor,
      proposedDescriptor: reviewRecords.get(flow.reviewId)?.proposedDescriptor,
      activeVocab: reviewRecords.get(flow.reviewId)?.activeVocab ?? [],
      approvedVocabUsed: reviewRecords.get(flow.reviewId)?.approvedVocabUsed ?? [],
      proposedVocab: reviewRecords.get(flow.reviewId)?.proposedVocab ?? [],
    })),
    vocabulary.values(),
  );
  const semanticIndex = buildSemanticIndex(
    reviewUnits.map((flow) => ({
      activeVocab: reviewRecords.get(flow.reviewId)?.activeVocab ?? [],
      approvedVocabUsed: reviewRecords.get(flow.reviewId)?.approvedVocabUsed ?? [],
      proposedVocab: reviewRecords.get(flow.reviewId)?.proposedVocab ?? [],
      activeDescriptor: reviewRecords.get(flow.reviewId)?.activeDescriptor,
      proposedDescriptor: reviewRecords.get(flow.reviewId)?.proposedDescriptor,
    })),
    vocabulary.values(),
    suppressionStats
  );
  if (reviewUnits.length === 0) {
    console.log("No flows to review.");
    return;
  }

  const rl = createInterface({ input, output });

  try {
    for (const flow of reviewUnits) {
      const existing = reviewRecords.get(flow.reviewId);
      const proposal =
        options.propose && !existing?.proposedDescriptor
          ? await proposeDescriptor(flow, vocabulary, suppressionStats, semanticIndex)
          : {
              descriptor: existing?.proposedDescriptor ?? buildProposedDescriptor(flow),
              approvedVocab: existing?.approvedVocabUsed ?? [],
              proposedVocab: existing?.proposedVocab ?? [],
              confidence: existing?.proposedConfidence ?? 0,
              rationale: existing?.proposedRationale ?? "No LLM proposal.",
            };
      const row = toFlowRows([flow])[0];

      console.log("");
      console.log(`Flow: ${row.flow}`);
      if (flow.variantSignature) {
        console.log(`Variant: ${flow.reviewId}`);
      }
      console.log(`Count: ${row.count}`);
      console.log(`Suites: ${row.suites}`);
      console.log(`Tests: ${row.tests}`);
      console.log(`Tool: ${row.tool}`);
      console.log(`Browser: ${row.browser}`);
      printDetailList("Final URLs", row.finalUrls);
      printDetailList("Headings", row.headings);
      printDetailList("Alerts", row.alerts);
      printDetailList("Targets", row.targets);
      console.log(`  Proposed descriptor: ${proposal.descriptor}`);
      console.log(`  Confidence: ${proposal.confidence.toFixed(2)}`);
      console.log(`  Rationale: ${proposal.rationale}`);
      console.log(`  Approved vocab: ${proposal.approvedVocab.join(", ") || "-"}`);
      console.log(`  Proposed vocab: ${proposal.proposedVocab.join(", ") || "-"}`);
      console.log(`  Approved vocabulary: ${[...vocabulary.keys()].sort().join(", ") || "-"}`);

      const action = (
        await rl.question("Action [a=approve, e=edit/override, r=reject, s=skip, q=quit]: ")
      ).trim().toLowerCase();

      if (action === "q") {
        break;
      }

      if (action === "s" || action === "") {
        continue;
      }

      const now = Date.now();

      if (action === "a") {
        reviewRecords.set(flow.reviewId, {
          ...materializeReviewUnitRecord(flow, reviewRecords.get(flow.reviewId)),
          proposedDescriptor: proposal.descriptor,
          proposedConfidence: proposal.confidence,
          proposedRationale: proposal.rationale,
          proposalState: "proposed",
          activeDescriptor: proposal.descriptor,
          approvedVocabUsed:
            proposal.approvedVocab.length > 0
              ? proposal.approvedVocab
              : collectUsedVocab(proposal.descriptor, vocabulary),
          proposedVocab: proposal.proposedVocab,
          activeVocab: sortStrings([
            ...(proposal.approvedVocab.length > 0
              ? proposal.approvedVocab
              : collectUsedVocab(proposal.descriptor, vocabulary)),
            ...proposal.proposedVocab,
          ]),
          proposalError: undefined,
          updatedAt: now,
        });
        await saveReviewUnits(reviewRecords);
        continue;
      }

      if (action === "r") {
        const notes = (await rl.question("Rejection notes (optional): ")).trim();
        reviewRecords.set(flow.reviewId, {
          ...materializeReviewUnitRecord(flow, reviewRecords.get(flow.reviewId)),
          proposedDescriptor: proposal.descriptor,
          proposedConfidence: proposal.confidence,
          proposedRationale: proposal.rationale,
          proposalState: "error",
          proposalError: notes || "Rejected via CLI review",
          notes: notes || undefined,
          approvedVocabUsed: proposal.approvedVocab,
          proposedVocab: proposal.proposedVocab,
          activeDescriptor: undefined,
          activeVocab: [],
          updatedAt: now,
        });
        await saveReviewUnits(reviewRecords);
        continue;
      }

      if (action === "e") {
        const approvedDescriptor = (await rl.question("Approved descriptor: ")).trim();
        if (!approvedDescriptor) {
          console.log("Descriptor cannot be empty. Skipping.");
          continue;
        }

        const promotedTermsInput = (await rl.question("Promote vocab terms (comma-separated, optional): ")).trim();
        const promotedTerms = promotedTermsInput
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);

        for (const term of promotedTerms) {
          vocabulary.set(term, {
            term,
            status: "approved",
            updatedAt: now,
          });
        }

        const notes = (await rl.question("Notes (optional): ")).trim();
        const approvedVocabUsed = collectUsedVocab(approvedDescriptor, vocabulary);
        reviewRecords.set(flow.reviewId, {
          ...materializeReviewUnitRecord(flow, reviewRecords.get(flow.reviewId)),
          proposedDescriptor: proposal.descriptor,
          proposedConfidence: proposal.confidence,
          proposedRationale: proposal.rationale,
          proposalState: "proposed",
          activeDescriptor: approvedDescriptor,
          notes: notes || undefined,
          approvedVocabUsed,
          proposedVocab: [...new Set([...proposal.proposedVocab, ...promotedTerms])].sort((a, b) => a.localeCompare(b)),
          activeVocab: sortStrings([...approvedVocabUsed, ...proposal.proposedVocab, ...promotedTerms]),
          interpretationStatus: "edited",
          proposalError: undefined,
          updatedAt: now,
        });
        await saveVocabulary(vocabulary);
        await saveReviewUnits(reviewRecords);
        continue;
      }

      console.log("Unknown action. Skipping.");
    }
  } finally {
    rl.close();
  }
}

async function rebuildReviewArtifacts() {
  await buildReviewUnits();
  await queueProposalProcessing();
  console.log("Rebuilt review units from captured evidence.");
}

function parseSyntheticNumber(args: string[], ...flags: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    if (!flags.includes(args[index])) {
      continue;
    }
    const value = Number.parseInt(args[index + 1] ?? "", 10);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

async function seedSyntheticDataset(args: string[]) {
  const units = parseSyntheticNumber(args, "--units", "-u") ?? 150;
  const runsPerUnit = parseSyntheticNumber(args, "--runs-per-unit", "-r") ?? 2;
  const offset = parseSyntheticNumber(args, "--offset") ?? 0;
  const shouldBuild = args.includes("--build");
  const shouldPropose = args.includes("--propose");
  const seeded = await seedSyntheticRuntimeData({ units, runsPerUnit, offset });

  if (shouldBuild || shouldPropose) {
    await buildReviewUnits();
  }
  if (shouldPropose) {
    await queueProposalProcessing();
  }

  console.log(
    `Seeded synthetic dataset: units=${seeded.units} runs=${seeded.totalRuns} runsPerUnit=${seeded.runsPerUnit}${shouldBuild ? " built=1" : ""}${shouldPropose ? " proposed=1" : ""}`
  );
}

async function benchmarkSyntheticDataset(args: string[]) {
  const units = parseSyntheticNumber(args, "--units", "-u") ?? 500;
  const runsPerUnit = parseSyntheticNumber(args, "--runs-per-unit", "-r") ?? 2;
  const offset = parseSyntheticNumber(args, "--offset") ?? 0;
  const seeded = await seedSyntheticRuntimeData({ units, runsPerUnit, offset });

  const buildStart = Date.now();
  await buildReviewUnits();
  const buildMs = Date.now() - buildStart;

  const proposeStart = Date.now();
  await queueProposalProcessing();
  const proposeMs = Date.now() - proposeStart;

  console.log(
    `Synthetic benchmark complete: units=${seeded.units} runs=${seeded.totalRuns} buildMs=${buildMs} proposeMs=${proposeMs} concurrency=${process.env.WDYT_REVIEW_CONCURRENCY ?? "10"} fakeLlm=${process.env.WDYT_LLM_FAKE === "1" ? "1" : "0"} fakeLatencyMs=${process.env.WDYT_LLM_FAKE_LATENCY_MS ?? "0"}`
  );
}

async function main() {
  const [, , command, ...args] = process.argv;

  const artifactUsage = [
    "Usage:",
    "  wdyt artifact",
    "  wdyt artifact export [--format zip|pdf] [--output <path>]",
    "  wdyt artifact import <zip-path> [more-zip-paths...]",
    "",
    "Commands:",
    "  export    Create a snapshot zip of the current wdyt runtime data",
    "  import    Restore wdyt runtime data from an artifact zip",
    "",
    "Options:",
    "  -f, --format <format>  Export format: zip (default) or pdf",
    "  -o, --output <path>   Output zip path or directory for export",
    "",
    "Default export location:",
    `  zip: ./${DEFAULT_EXPORT_FILE_NAMES.zip}`,
    `  pdf: ./${DEFAULT_EXPORT_FILE_NAMES.pdf}`,
  ].join("\n");

  const syntheticUsage = [
    "Usage:",
    "  wdyt synthetic seed [--units <count>] [--runs-per-unit <count>] [--offset <count>] [--build] [--propose]",
    "  wdyt synthetic benchmark [--units <count>] [--runs-per-unit <count>] [--offset <count>]",
    "",
    "Commands:",
    "  seed       Replace the current wdyt runtime data with a synthetic dataset",
    "  benchmark  Seed a synthetic dataset, rebuild review units, and run proposals",
    "",
    "Notes:",
    "  Use WDYT_LLM_FAKE=1 and WDYT_LLM_FAKE_LATENCY_MS=<ms> to stress the proposal worker without spending tokens.",
  ].join("\n");

  if (command === "flows") {
    await printFlows({
      verbose: args.includes("--verbose"),
    });
    return;
  }

  if (command === "review") {
    if (args.includes("--rebuild")) {
      await rebuildReviewArtifacts();
      return;
    }

    await reviewFlows({
      propose: args.includes("--propose"),
    });
    return;
  }

  if (command === "artifact") {
    const subcommand = args[0];

    if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
      console.log(artifactUsage);
      return;
    }

    if (subcommand === "import") {
      const artifactPaths = args.slice(1);
      if (artifactPaths.length === 0) {
        console.error(artifactUsage);
        process.exitCode = 1;
        return;
      }

      console.log(await importArtifacts(artifactPaths));
      return;
    }

    if (subcommand === "export") {
      let outputPath;
      let format = "zip";
      for (let index = 1; index < args.length; index += 1) {
        const value = args[index];
        if (value === "--format" || value === "-f") {
          format = args[index + 1] ?? "";
          index += 1;
          continue;
        }
        if (value === "--output" || value === "-o") {
          outputPath = args[index + 1];
          index += 1;
          continue;
        }
      }

      if ((args.includes("--format") || args.includes("-f")) && !format) {
        console.error(artifactUsage);
        process.exitCode = 1;
        return;
      }

      if ((args.includes("--output") || args.includes("-o")) && !outputPath) {
        console.error(artifactUsage);
        process.exitCode = 1;
        return;
      }

      if (format !== "zip" && format !== "pdf") {
        console.error(artifactUsage);
        process.exitCode = 1;
        return;
      }

      const targetPath = await exportArtifact({
        format,
        outputPath,
        pdfMode: process.env.WDYT_PDF_STUB === "1" ? "stub" : "puppeteer",
      });

      if (format === "pdf") {
        console.log(`Report generated: ${targetPath}`);
        return;
      }

      console.log(targetPath);
      return;
    }

    console.error(artifactUsage);
    process.exitCode = 1;
    return;
  }

  if (command === "synthetic") {
    const subcommand = args[0];
    if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
      console.log(syntheticUsage);
      return;
    }

    if (subcommand === "seed") {
      await seedSyntheticDataset(args.slice(1));
      return;
    }

    if (subcommand === "benchmark") {
      await benchmarkSyntheticDataset(args.slice(1));
      return;
    }

    console.error(syntheticUsage);
    process.exitCode = 1;
    return;
  }

  console.error("Usage: wdyt flows [--verbose] | wdyt review [--propose|--rebuild] | wdyt artifact");
  process.exitCode = 1;
}

await main();
