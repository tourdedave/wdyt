#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EXPORT_FILE_NAMES, exportArtifact } from "../artifact/exportArtifact.js";
import { importArtifacts } from "../artifact/importArtifact.js";
import { buildReviewUnits, loadReviewUnitViews, queueProposalProcessing } from "../server/review.js";
import { startWdytServer } from "../server/index.js";
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
  ReviewUnitViewRecord,
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
  displayTitle?: string;
};

type ReviewUnit = GroupedFlow & {
  reviewId: string;
  runId: string;
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

function getFlowTitleFromUnits(
  units: Array<Pick<ReviewUnitViewRecord, "activeDescriptor" | "proposedDescriptor" | "canonical">>
) {
  const descriptors = units
    .map((unit) => String(unit.activeDescriptor || unit.proposedDescriptor || "").trim())
    .filter(Boolean);

  if (descriptors.length === 0) {
    return units[0] ? formatFlow(units[0].canonical) : "-";
  }

  const counts = new Map<string, number>();
  descriptors.forEach((descriptor) => {
    counts.set(descriptor, (counts.get(descriptor) || 0) + 1);
  });

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0][0];
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
  const units = await loadReviewUnitViews();
  const groups = new Map<string, GroupedFlow & { sourceUnits: ReviewUnitViewRecord[] }>();

  for (const unit of units) {
    const key = String(unit.structureKey || unit.flowId || unit.reviewId).trim();
    const current = groups.get(key) ?? {
      flowId: key,
      count: 0,
      canonical: unit.canonical,
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
      displayTitle: undefined,
      sourceUnits: [],
    };

    current.count += 1;
    current.sourceUnits.push(unit);
    unit.suites.forEach((value) => current.suites.add(value));
    unit.tests.forEach((value) => current.tests.add(value));
    unit.tools.forEach((value) => current.tools.add(value));
    unit.browsers.forEach((value) => current.browsers.add(value));
    unit.urls.forEach((value) => current.urls.add(value));
    unit.targets.forEach((value) => current.targets.add(value));
    unit.finalUrls.forEach((value) => current.finalUrls.add(value));
    unit.titles.forEach((value) => current.titles.add(value));
    unit.headings.forEach((value) => current.headings.add(value));
    unit.alerts.forEach((value) => current.alerts.add(value));
    current.displayTitle = getFlowTitleFromUnits(current.sourceUnits);

    groups.set(key, current);
  }

  return [...groups.values()]
    .sort((a, b) => b.count - a.count || (a.displayTitle || "").localeCompare(b.displayTitle || ""))
    .map(({ sourceUnits: _sourceUnits, ...group }) => group);
}

async function loadReviewUnits() {
  const records = await readJsonLines<ProcessedRunRecord>(getProcessedRunsPath());
  const rawRuns = await readJsonLines<IngestPayload>(getRawRunsPath());
  const rawRunById = new Map(rawRuns.map((run) => [run.run.id, run]));

  const reviewUnits: ReviewUnit[] = [];

  for (const record of records) {
    const rawRun = rawRunById.get(record.runId);
    const unit: ReviewUnit = {
      reviewId: record.runId,
      runId: record.runId,
      flowId: record.flowId,
      variantSignature: getVariantSignature(record),
      count: 1,
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

    reviewUnits.push(unit);
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
    flow: flow.displayTitle || formatFlow(flow.canonical),
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
    runId: flow.runId,
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

async function rebuildReviewArtifacts() {
  await buildReviewUnits();
  await queueProposalProcessing();
  console.log("Rebuilt review units from captured evidence.");
}

async function waitForPendingEnrichment(timeoutMs: number) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const reviewUnits = await readJsonFile<ReviewUnitRecord[]>(getReviewUnitsPath(), []);
    const hasPending = reviewUnits.some((unit) => unit.proposalState === "pending" || unit.proposalState === "processing");
    if (!hasPending) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for pending enrichment after ${timeoutMs}ms`);
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
  const offset = parseSyntheticNumber(args, "--offset") ?? 0;
  const shouldBuild = args.includes("--build");
  const shouldPropose = args.includes("--propose");
  const seeded = await seedSyntheticRuntimeData({ units, offset });

  if (shouldBuild || shouldPropose) {
    await buildReviewUnits();
  }
  if (shouldPropose) {
    await queueProposalProcessing();
  }

  console.log(
    `Seeded synthetic dataset: units=${seeded.units} runs=${seeded.totalRuns}${shouldBuild ? " built=1" : ""}${shouldPropose ? " proposed=1" : ""}`
  );
}

async function benchmarkSyntheticDataset(args: string[]) {
  const units = parseSyntheticNumber(args, "--units", "-u") ?? 500;
  const offset = parseSyntheticNumber(args, "--offset") ?? 0;
  const seeded = await seedSyntheticRuntimeData({ units, offset });

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
    "  wdyt artifact export [--format zip] [--output <path>] [--wait-for-enrichment] [--wait-timeout-ms <ms>]",
    "  wdyt artifact import <zip-path> [more-zip-paths...]",
    "",
    "Commands:",
    "  export    Create a snapshot zip of the current wdyt runtime data",
    "  import    Restore wdyt runtime data from an artifact zip",
    "",
    "Options:",
    "  -f, --format <format>  Export format: zip (default)",
    "  -o, --output <path>   Output zip path or directory for export",
    "      --wait-for-enrichment  Wait for pending/processing review-unit enrichment to settle before export",
    "      --wait-timeout-ms <ms> Timeout for --wait-for-enrichment (default: 300000)",
    "",
    "Default export location:",
    `  zip: ./${DEFAULT_EXPORT_FILE_NAMES.zip}`,
  ].join("\n");

  const syntheticUsage = [
    "Usage:",
    "  wdyt settings synthetic seed [--units <count>] [--offset <count>] [--build] [--propose]",
    "  wdyt settings synthetic benchmark [--units <count>] [--offset <count>]",
    "",
    "Commands:",
    "  seed       Replace the current wdyt runtime data with a synthetic dataset",
    "  benchmark  Seed a synthetic dataset, rebuild review units, and run proposals",
    "",
    "Notes:",
    "  Use WDYT_LLM_FAKE=1 and WDYT_LLM_FAKE_LATENCY_MS=<ms> to stress the proposal worker without spending tokens.",
  ].join("\n");

  const settingsUsage = [
    "Usage:",
    "  wdyt settings rebuild",
    "  wdyt settings synthetic seed [--units <count>] [--offset <count>] [--build] [--propose]",
    "  wdyt settings synthetic benchmark [--units <count>] [--offset <count>]",
  ].join("\n");

  const topLevelUsage = [
    "Usage:",
    "  wdyt server start",
    "  wdyt flows [--verbose]",
    "  wdyt artifact",
    "  wdyt settings",
  ].join("\n");

  if (command === "server") {
    const subcommand = args[0];
    if (subcommand === "start") {
      await startWdytServer();
      return;
    }

    console.error(topLevelUsage);
    process.exitCode = 1;
    return;
  }

  if (command === "flows") {
    await printFlows({
      verbose: args.includes("--verbose"),
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
      let waitForEnrichment = false;
      let waitTimeoutMs = 300_000;
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
        if (value === "--wait-for-enrichment") {
          waitForEnrichment = true;
          continue;
        }
        if (value === "--wait-timeout-ms") {
          const parsed = Number.parseInt(args[index + 1] ?? "", 10);
          waitTimeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : NaN;
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

      if (args.includes("--wait-timeout-ms") && !Number.isFinite(waitTimeoutMs)) {
        console.error(artifactUsage);
        process.exitCode = 1;
        return;
      }

      if (format !== "zip") {
        console.error(artifactUsage);
        process.exitCode = 1;
        return;
      }

      if (waitForEnrichment) {
        await waitForPendingEnrichment(waitTimeoutMs);
      }

      const targetPath = await exportArtifact({
        format,
        outputPath,
      });

      console.log(targetPath);
      return;
    }

    console.error(artifactUsage);
    process.exitCode = 1;
    return;
  }

  if (command === "settings") {
    const subcommand = args[0];
    if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
      console.log(settingsUsage);
      return;
    }

    if (subcommand === "rebuild") {
      await rebuildReviewArtifacts();
      return;
    }

    if (subcommand === "synthetic") {
      const syntheticCommand = args[1];
      if (
        !syntheticCommand ||
        syntheticCommand === "help" ||
        syntheticCommand === "--help" ||
        syntheticCommand === "-h"
      ) {
        console.log(syntheticUsage);
        return;
      }

      if (syntheticCommand === "seed") {
        await seedSyntheticDataset(args.slice(2));
        return;
      }

      if (syntheticCommand === "benchmark") {
        await benchmarkSyntheticDataset(args.slice(2));
        return;
      }

      console.error(syntheticUsage);
      process.exitCode = 1;
      return;
    }

    console.error(settingsUsage);
    process.exitCode = 1;
    return;
  }

  console.error(topLevelUsage);
  process.exitCode = 1;
}

await main();
