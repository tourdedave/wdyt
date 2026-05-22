import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getDataDir,
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
  FlowDescriptorProposal,
  FlowRoleEvidence,
  FlowTermRole,
  FlowTermRoleClassification,
  IngestPayload,
  PrerequisiteAnalysis,
  ProcessedRunRecord,
  ResolvedFlowConcept,
  ReviewUnitRecord,
  ReviewUnitViewRecord,
  VocabStats,
  VocabularyEntry,
} from "../shared/types.js";
import { analyzePrerequisites, collectVocabStats, inferEvidenceTerms, inferSourceAwareTermCandidates, scoreFlowTermRoles } from "../shared/flow-suppression.js";
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
  normalizeOverlapTerms,
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
import { getRequiredLlmConfig, requestJsonCompletion } from "./llm.js";
import { logProcessMemoryUsage } from "./memory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reviewSystemPromptPath = path.join(__dirname, "../prompts/review-system-prompt.txt");
const reviewTermRolePromptPath = path.join(__dirname, "../prompts/review-term-role-system-prompt.txt");
const reviewEvidenceClassificationPromptPath = path.join(__dirname, "../prompts/review-evidence-classification-system-prompt.txt");
const reviewConceptResolutionPromptPath = path.join(__dirname, "../prompts/review-concept-resolution-system-prompt.txt");

let processingQueue = false;
let reviewUnitWriteChain: Promise<unknown> = Promise.resolve();
let reviewUnitCache:
  | {
      dataDir: string;
      units: ReviewUnitRecord[];
      views: ReviewUnitViewRecord[];
    }
  | null = null;

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
  runId: string;
  variantSignature?: string;
};

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

function getVariantSignature(record: ProcessedRunRecord) {
  return JSON.stringify({
    finalUrl: record.endState?.finalUrl ?? null,
    title: record.endState?.title ?? null,
    heading: record.endState?.heading ?? null,
    alertText: record.endState?.alertText ?? null,
  });
}

function normalizeStructureValues(values: string[] | undefined) {
  return [...new Set((values ?? []).map((value) => String(value).trim().toLowerCase()).filter(Boolean))].sort();
}

export function getReviewUnitStructureKey(
  unit: Pick<ReviewUnitRecord, "flowId" | "canonical">
) {
  return String(unit.flowId || "").trim() || JSON.stringify({
    canonical: Array.isArray(unit.canonical) ? unit.canonical.map((step) => String(step).trim()) : [],
  });
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function clampConfidence(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function normalizeFlowDescriptorProposal(value: unknown, vocabulary: VocabularyEntry[]): FlowDescriptorProposal | null {
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

function normalizeFlowTermRoleClassification(value: unknown, fallback: PrerequisiteAnalysis): FlowTermRoleClassification {
  const normalizedTerms = new Set([
    ...fallback.prerequisiteTerms,
    ...fallback.primaryTerms,
  ]);

  if (!value || typeof value !== "object") {
    return {
      prerequisiteTerms: [...fallback.prerequisiteTerms].sort((a, b) => a.localeCompare(b)),
      primaryTerms: [...fallback.primaryTerms].sort((a, b) => a.localeCompare(b)),
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
    normalizedTerms.add(term);
    byRole.get(role)?.add(term);
  }

  if ((byRole.get("primary")?.size ?? 0) === 0) {
    for (const term of fallback.primaryTerms) {
      byRole.get("primary")?.add(term);
      normalizedTerms.add(term);
    }
  }

  if ((byRole.get("prerequisite")?.size ?? 0) === 0) {
    for (const term of fallback.prerequisiteTerms) {
      byRole.get("prerequisite")?.add(term);
      normalizedTerms.add(term);
    }
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

  return {
    prerequisiteTerms,
    primaryTerms,
    outcomeTerms,
    uncertainTerms,
  };
}

async function loadVocabulary() {
  return readJsonFile<VocabularyEntry[]>(getVocabularyPath(), []);
}

function invalidateReviewUnitCache() {
  reviewUnitCache = null;
}

function getActiveReviewUnitCache() {
  const dataDir = getDataDir();
  if (!reviewUnitCache || reviewUnitCache.dataDir !== dataDir) {
    return null;
  }

  return reviewUnitCache;
}

function getActiveDescriptor(unit: Partial<ReviewUnitRecord>) {
  return unit.activeDescriptor ?? unit.proposedDescriptor;
}

function getActiveVocab(unit: Partial<ReviewUnitRecord>, vocabulary: VocabularyEntry[]) {
  const active = Array.isArray(unit.activeVocab) ? unit.activeVocab : [];
  if (active.length > 0) {
    return normalizeProposedVocabulary(active, vocabulary);
  }

  return normalizeProposedVocabulary([...(unit.approvedVocabUsed ?? []), ...(unit.proposedVocab ?? [])], vocabulary);
}

function deriveOverlapTerms(unit: Partial<ReviewUnitRecord>, activeVocab: string[], vocabulary: VocabularyEntry[]) {
  const semanticTerms = [
    ...(Array.isArray(unit.primaryTerms) ? unit.primaryTerms : []),
    ...(Array.isArray(unit.outcomeTerms) ? unit.outcomeTerms : []),
  ];

  if (semanticTerms.length > 0) {
    return normalizeOverlapTerms(semanticTerms, vocabulary);
  }

  return normalizeOverlapTerms(activeVocab, vocabulary);
}

function materializeActiveFields(unit: ReviewUnitRecord, vocabulary: VocabularyEntry[]) {
  const normalized = getActiveVocab(unit, vocabulary);
  const activeVocab = [...new Set([...normalized.approvedVocab, ...normalized.proposedVocab])].sort((a, b) => a.localeCompare(b));
  const activeDescriptor = getActiveDescriptor(unit);
  const interpretationStatus = unit.interpretationStatus ?? "auto-generated";

  return {
    ...unit,
    structureKey: getReviewUnitStructureKey(unit),
    activeDescriptor,
    activeVocab,
    prerequisiteTerms: Array.isArray(unit.prerequisiteTerms) ? unit.prerequisiteTerms : [],
    primaryTerms: Array.isArray(unit.primaryTerms) ? unit.primaryTerms : [],
    outcomeTerms: Array.isArray(unit.outcomeTerms) ? unit.outcomeTerms : [],
    uncertainTerms: Array.isArray(unit.uncertainTerms) ? unit.uncertainTerms : [],
    evidenceItems: Array.isArray(unit.evidenceItems) ? unit.evidenceItems : [],
    conceptResolutions: Array.isArray(unit.conceptResolutions) ? unit.conceptResolutions : [],
    roleEvidence: unit.roleEvidence,
    overlapTerms: deriveOverlapTerms(unit, activeVocab, vocabulary),
    interpretationStatus,
  };
}

function buildGlobalVocabStats(units: ReviewUnitRecord[], vocabulary: VocabularyEntry[]) {
  return collectVocabStats(units, vocabulary);
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

function materializeSuppressedView(unit: ReviewUnitRecord, stats: Map<string, VocabStats>): ReviewUnitViewRecord {
  const analysis =
    (unit.primaryTerms?.length || unit.prerequisiteTerms?.length)
      ? {
          prerequisiteTerms: unit.prerequisiteTerms ?? [],
          primaryTerms: unit.primaryTerms ?? [],
        }
      : analyzePrerequisites(unit.activeVocab, stats, {
          maxIdf: 0.9,
          minDistinctDescriptorCount: 3,
        });
  return {
    ...unit,
    prerequisites: analysis.prerequisiteTerms,
    primaryTerms: analysis.primaryTerms,
  };
}

async function saveReviewUnits(units: ReviewUnitRecord[]) {
  const sortedUnits = [...units].sort((a, b) => a.reviewId.localeCompare(b.reviewId));
  await writeJsonFile(getReviewUnitsPath(), sortedUnits);
  const vocabulary = await loadVocabulary();
  const materializedUnits = sortedUnits.map((unit) => materializeActiveFields(unit, vocabulary));
  const stats = buildGlobalVocabStats(materializedUnits, vocabulary);
  reviewUnitCache = {
    dataDir: getDataDir(),
    units: materializedUnits,
    views: materializedUnits.map((unit) => materializeSuppressedView(unit, stats)),
  };
}

type MaterializedReviewUnitRecord = Awaited<ReturnType<typeof loadReviewUnits>>[number];

async function patchReviewUnit(
  reviewId: string,
  update: (unit: MaterializedReviewUnitRecord) => MaterializedReviewUnitRecord | null
) {
  const task = reviewUnitWriteChain.then(async () => {
    const reviewUnits = await loadReviewUnits();
    const index = reviewUnits.findIndex((unit) => unit.reviewId === reviewId);

    if (index < 0) {
      return null;
    }

    const nextUnit = update(reviewUnits[index]);

    if (!nextUnit) {
      return null;
    }

    reviewUnits[index] = nextUnit;
    await saveReviewUnits(reviewUnits);
    return nextUnit;
  });

  reviewUnitWriteChain = task.catch(() => {});
  return task;
}

export async function loadReviewUnits() {
  const cached = getActiveReviewUnitCache();
  if (cached) {
    return cached.units.map((unit: ReviewUnitRecord) => ({ ...unit }));
  }

  const units = await readJsonFile<ReviewUnitRecord[]>(getReviewUnitsPath(), []);
  const vocabulary = await loadVocabulary();
  const materializedUnits = units.map((unit) => materializeActiveFields(unit, vocabulary));
  const stats = buildGlobalVocabStats(materializedUnits, vocabulary);
  reviewUnitCache = {
    dataDir: getDataDir(),
    units: materializedUnits,
    views: materializedUnits.map((unit) => materializeSuppressedView(unit, stats)),
  };
  return materializedUnits.map((unit) => ({ ...unit }));
}

export async function loadReviewUnitViews() {
  const cached = getActiveReviewUnitCache();
  if (cached) {
    return cached.views.map((unit: ReviewUnitViewRecord) => ({ ...unit }));
  }

  await loadReviewUnits();
  const refreshedCache = getActiveReviewUnitCache();
  return refreshedCache ? refreshedCache.views.map((unit: ReviewUnitViewRecord) => ({ ...unit })) : [];
}

export async function loadReviewUnitView(reviewId: string) {
  const units = await loadReviewUnitViews();
  return units.find((unit) => unit.reviewId === reviewId) ?? null;
}

export async function getReviewUnitViewCount() {
  const units = await loadReviewUnits();
  return units.length;
}

function matchesReviewUnitQuery(unit: ReviewUnitViewRecord, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const confidenceFilters = new Set<string>();
  const normalizedTextQuery = normalizedQuery
    .replace(/\bconfidence:(low|moderate|high)\b/g, (_match, bucket: string) => {
      confidenceFilters.add(bucket);
      return " ";
    })
    .replace(/\b(low|moderate|high)\s+confidence\b/g, (_match, bucket: string) => {
      confidenceFilters.add(bucket);
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();

  if (confidenceFilters.size > 0) {
    const confidence = typeof unit.proposedConfidence === "number" ? unit.proposedConfidence : null;
    const bucket =
      confidence == null
        ? "low"
        : confidence >= 0.8
          ? "high"
          : confidence >= 0.6
            ? "moderate"
            : "low";
    if (!confidenceFilters.has(bucket)) {
      return false;
    }
  }

  if (!normalizedTextQuery) {
    return true;
  }

  const haystacks = [
    unit.reviewId,
    unit.flowId,
    unit.activeDescriptor,
    unit.proposedDescriptor,
    ...(unit.tests ?? []),
    ...(unit.suites ?? []),
    ...(unit.tools ?? []),
    ...(unit.browsers ?? []),
    ...(unit.primaryTerms ?? []),
    ...(unit.prerequisites ?? []),
    ...(unit.outcomeTerms ?? []),
    ...(unit.activeVocab ?? []),
    ...(unit.finalUrls ?? []),
    ...(unit.headings ?? []),
  ];

  return haystacks.some((value) => String(value ?? "").toLowerCase().includes(normalizedTextQuery));
}

export async function queryReviewUnitViews(input?: {
  page?: number;
  pageSize?: number;
  query?: string;
  structureKey?: string;
}) {
  const page = Number.isFinite(input?.page) && (input?.page ?? 0) > 0 ? Math.floor(input?.page ?? 1) : 1;
  const requestedPageSize =
    Number.isFinite(input?.pageSize) && (input?.pageSize ?? 0) > 0 ? Math.floor(input?.pageSize ?? 50) : 50;
  const pageSize = Math.max(1, Math.min(requestedPageSize, 100));
  const query = input?.query?.trim() ?? "";
  const structureKey = input?.structureKey?.trim() ?? "";
  const allUnits = await loadReviewUnitViews();
  const structurallyFilteredUnits = structureKey
    ? allUnits.filter((unit) => unit.structureKey === structureKey)
    : allUnits;
  const filteredUnits = query
    ? structurallyFilteredUnits.filter((unit) => matchesReviewUnitQuery(unit, query))
    : structurallyFilteredUnits;
  const total = filteredUnits.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const startIndex = (clampedPage - 1) * pageSize;
  const units = filteredUnits.slice(startIndex, startIndex + pageSize);

  return {
    units,
    total,
    page: clampedPage,
    pageSize,
    totalPages,
    query,
    structureKey,
  };
}

export async function buildReviewUnits(input?: { preserveExisting?: boolean }) {
  console.log("[WDYT] rebuilding review units from persisted runs");
  logProcessMemoryUsage("review-build:start");
  const preserveExisting = input?.preserveExisting === true;
  const records = await readJsonLines<ProcessedRunRecord>(getProcessedRunsPath());
  const rawRuns = await readJsonLines<IngestPayload>(getRawRunsPath());
  const rawRunById = new Map(rawRuns.map((run) => [run.run.id, run]));
  const existingReviewUnits = preserveExisting
    ? await readJsonFile<ReviewUnitRecord[]>(getReviewUnitsPath(), [])
    : [];
  const existingByReviewId = new Map(existingReviewUnits.map((unit) => [unit.reviewId, unit]));

  const reviewUnits: ReviewUnit[] = [];

  for (const record of records) {
    const rawRun = rawRunById.get(record.runId);
    const variantSignature = getVariantSignature(record);
    const unit: ReviewUnit = {
      reviewId: record.runId,
      runId: record.runId,
      flowId: record.flowId,
      variantSignature,
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

  const vocabulary = await loadVocabulary();
  const now = Date.now();

  const materialized: ReviewUnitRecord[] = reviewUnits
    .sort((a, b) => b.count - a.count || a.reviewId.localeCompare(b.reviewId))
    .map((unit) => {
      const baseRecord = {
        reviewId: unit.reviewId,
        runId: unit.runId,
        flowId: unit.flowId,
        variantSignature: unit.variantSignature,
        canonical: unit.canonical as ReviewUnitRecord["canonical"],
        count: unit.count,
        suites: [...unit.suites].sort(),
        tests: [...unit.tests].sort(),
        tools: [...unit.tools].filter((value) => value !== "-").sort(),
        browsers: [...unit.browsers].filter((value) => value !== "-").sort(),
        urls: [...unit.urls].sort(),
        targets: [...unit.targets].sort(),
        finalUrls: [...unit.finalUrls].sort(),
        titles: [...unit.titles].sort(),
        headings: [...unit.headings].sort(),
        alerts: [...unit.alerts].sort(),
      } satisfies Partial<ReviewUnitRecord>;
      const existing = existingByReviewId.get(unit.reviewId);

      return materializeActiveFields(
        existing
          ? {
              ...existing,
              ...baseRecord,
            }
          : {
              ...baseRecord,
              proposalState: "pending",
              approvedVocabUsed: [],
              proposedVocab: [],
              activeVocab: [],
              prerequisiteTerms: [],
              primaryTerms: [],
              outcomeTerms: [],
              uncertainTerms: [],
              evidenceItems: [],
              conceptResolutions: [],
              updatedAt: now,
            },
        vocabulary
      );
    });

  await saveReviewUnits(materialized);
  console.log(`[WDYT] review units ready count=${materialized.length}`);
  logProcessMemoryUsage("review-build:end");
  return materialized;
}

async function proposeDescriptor(
  unit: ReviewUnitRecord,
  vocabulary: VocabularyEntry[],
  stats: Map<string, VocabStats>,
  semanticIndex: ReturnType<typeof buildSemanticIndex>
) {
  const llmConfig = getRequiredLlmConfig();
  const baseUrl = llmConfig?.baseUrl ?? "";
  const model = llmConfig?.model ?? "";
  const apiKey = llmConfig?.apiKey ?? "";
  const systemPrompt = await readFile(reviewSystemPromptPath, "utf8");
  const roleSystemPrompt = await readFile(reviewTermRolePromptPath, "utf8");
  const evidenceClassificationSystemPrompt = await readFile(reviewEvidenceClassificationPromptPath, "utf8");
  const conceptResolutionSystemPrompt = await readFile(reviewConceptResolutionPromptPath, "utf8");
  const approvedVocabulary = getApprovedVocabulary(vocabulary)
    .map((entry) => ({
      term: entry.term,
      description: entry.description ?? null,
      aliases: entry.aliases ?? [],
    }));
  const registryMatches = findApprovedVocabularyMatches(
    [
      ...unit.urls,
      ...unit.finalUrls,
      ...unit.titles,
      ...unit.headings,
      ...unit.alerts,
      ...unit.targets,
      ...unit.tests,
    ],
    vocabulary
  );
  const inferredFlowTerms = inferEvidenceTerms(
    [
      ...unit.urls,
      ...unit.finalUrls,
      ...unit.titles,
      ...unit.headings,
      ...unit.alerts,
      ...unit.targets,
    ],
    stats,
    vocabulary,
    [...registryMatches, ...(unit.activeVocab ?? []), ...(unit.proposedVocab ?? [])]
  );
  const rawEvidenceItems = collectStructuredEvidenceItems({
    setupUrls: [...unit.urls.filter((value) => !unit.finalUrls.includes(value))],
    actionTargets: [...unit.targets],
    finalUrls: [...unit.finalUrls],
    titles: [...unit.titles],
    headings: [...unit.headings],
    alerts: [...unit.alerts],
  });
  const classifiedEvidenceItems = normalizeEvidenceClassification(
    await requestJsonCompletion({
      baseUrl,
      apiKey,
      model,
      systemPrompt: evidenceClassificationSystemPrompt,
      userPrompt: JSON.stringify(
        {
          reviewId: unit.reviewId,
          flowId: unit.flowId,
          canonical: unit.canonical,
          evidenceItems: rawEvidenceItems,
        },
        null,
        2
      ),
    }),
    rawEvidenceItems
  );
  const fallbackSourceCandidates = buildEvidenceCandidates(classifiedEvidenceItems, registryMatches, stats, vocabulary);
  const classifiedEvidenceBuckets = partitionEvidenceItems(classifiedEvidenceItems);
  const resolvedConcepts = filterResolvedConcepts(normalizeConceptResolution({
    value: await requestJsonCompletion({
      baseUrl,
      apiKey,
      model,
      systemPrompt: conceptResolutionSystemPrompt,
      userPrompt: JSON.stringify(
        {
          reviewId: unit.reviewId,
          flowId: unit.flowId,
          canonical: unit.canonical,
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
    vocabulary,
  }));
  const resolvedCandidates = dedupeFlowTermCandidates(resolvedConceptsToCandidates(resolvedConcepts));
  const flowTerms = [...new Set([...inferredFlowTerms, ...resolvedConcepts.map((concept) => concept.term)])].sort((a, b) =>
    a.localeCompare(b)
  );
  const evidenceBuckets = partitionTermCandidates(resolvedCandidates);
  const roleHints: PrerequisiteAnalysis = scoreFlowTermRoles(resolvedCandidates, stats, semanticIndex);
  const semanticNeighbors = Object.fromEntries(
    resolvedConcepts.map((concept) => [concept.term, concept.neighbors])
  );
  const roleEvidence = {
    reviewId: unit.reviewId,
    flowId: unit.flowId,
    canonical: unit.canonical,
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
    tests: unit.tests,
    urls: unit.urls.slice(0, 5),
    finalUrls: unit.finalUrls.slice(0, 5),
    titles: unit.titles.slice(0, 5),
    headings: unit.headings.slice(0, 5),
    alerts: unit.alerts.slice(0, 5),
    targets: unit.targets.slice(0, 5),
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
    reviewId: unit.reviewId,
    flowId: unit.flowId,
    variantSignature: unit.variantSignature ?? null,
    canonical: unit.canonical,
    allFlowTerms: flowTerms,
    flowTerms: descriptorFocusTerms,
    prerequisiteTerms: classifiedTerms.prerequisiteTerms,
    primaryTerms: classifiedTerms.primaryTerms,
    outcomeTerms: classifiedTerms.outcomeTerms,
    uncertainTerms: classifiedTerms.uncertainTerms,
    descriptorExcludedTerms,
    count: unit.count,
    suites: unit.suites,
    tests: unit.tests,
    tools: unit.tools,
    browsers: unit.browsers,
    urls: unit.urls.slice(0, 5),
    finalUrls: unit.finalUrls.slice(0, 5),
    titles: unit.titles.slice(0, 5),
    headings: unit.headings.slice(0, 5),
    alerts: unit.alerts.slice(0, 5),
    targets: unit.targets.slice(0, 5),
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
      vocabulary
    );

    if (!parsed) {
      throw new Error("LLM response did not match expected proposal schema");
    }

    return parsed;
  }

  let parsed = await generateProposal();
  let validation = validateProposal(evidence, parsed, vocabulary);
  const retryFeedback = buildProposalRetryFeedback(validation.issues);
  if (retryFeedback) {
    parsed = await generateProposal(retryFeedback);
    validation = validateProposal(evidence, parsed, vocabulary);
  }
  if (validation.issues.some((issue) => issue.includes("The descriptor includes descriptor-excluded terms."))) {
    parsed = {
      ...parsed,
      descriptor: sanitizeDescriptorExcludedTerms(parsed.descriptor, descriptorExcludedTerms),
    };
    validation = validateProposal(evidence, parsed, vocabulary);
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
    validation = validateProposal(evidence, parsed, vocabulary);
  }
  parsed = {
    ...parsed,
    descriptor: normalizeDescriptorStyle(parsed.descriptor),
  };
  validation = validateProposal(evidence, parsed, vocabulary);
  const filteredApprovedVocabUsed = descriptorExcludedTerms.length > 0
    ? parsed.approvedVocab.filter((term) => !includesDescriptorExcludedTerm(term, descriptorExcludedTerms))
    : parsed.approvedVocab;
  const filteredProposedVocab = parsed.proposedVocab.filter((term) =>
    !isLowValueProposalTerm(term) && !includesDescriptorExcludedTerm(term, descriptorExcludedTerms)
  );
  const adjustedConfidence = scoreProposalConfidence(evidence, parsed, validation.issues);

  return {
    proposedDescriptor: parsed.descriptor,
    proposedConfidence: adjustedConfidence,
    proposedRationale: parsed.rationale,
    approvedVocabUsed: filteredApprovedVocabUsed,
    proposedVocab: filteredProposedVocab,
    prerequisiteTerms: classifiedTerms.prerequisiteTerms,
    primaryTerms: classifiedTerms.primaryTerms,
    outcomeTerms: classifiedTerms.outcomeTerms,
    uncertainTerms: classifiedTerms.uncertainTerms,
    evidenceItems: classifiedEvidenceItems,
    conceptResolutions: resolvedConcepts,
    roleEvidence: roleEvidenceSummary,
  };
}

function getProposalWorkerConcurrency() {
  const parsed = Number.parseInt(process.env.WDYT_LLM_CONCURRENCY ?? "10", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 10;
  }

  return Math.min(parsed, 16);
}

async function processProposalUnit(
  unit: ReviewUnitRecord,
  vocabulary: VocabularyEntry[],
  stats: Map<string, VocabStats>,
  semanticIndex: ReturnType<typeof buildSemanticIndex>
) {
  console.log(`[WDYT] proposing descriptor reviewId=${unit.reviewId}`);
  const processingReviewId = unit.reviewId;
  const markedUnit = await patchReviewUnit(processingReviewId, (current) => ({
    ...current,
    proposalState: "processing",
    proposalError: undefined,
    updatedAt: Date.now(),
  }));

  if (!markedUnit) {
    console.warn(`[WDYT] proposal skipped missing reviewId=${processingReviewId}`);
    return;
  }

  try {
    const proposal = await proposeDescriptor(unit, vocabulary, stats, semanticIndex);
    const proposedAt = Date.now();
    const updatedUnit = await patchReviewUnit(processingReviewId, (current) => ({
      ...current,
      proposalState: "proposed",
      proposedDescriptor: proposal.proposedDescriptor,
      proposedConfidence: proposal.proposedConfidence,
      proposedRationale: proposal.proposedRationale,
      approvedVocabUsed: proposal.approvedVocabUsed,
      proposedVocab: proposal.proposedVocab,
      prerequisiteTerms: proposal.prerequisiteTerms,
      primaryTerms: proposal.primaryTerms,
      outcomeTerms: proposal.outcomeTerms,
      uncertainTerms: proposal.uncertainTerms,
      evidenceItems: proposal.evidenceItems,
      conceptResolutions: proposal.conceptResolutions,
      roleEvidence: proposal.roleEvidence,
      activeDescriptor: proposal.proposedDescriptor,
      activeVocab: [...new Set([...proposal.approvedVocabUsed, ...proposal.proposedVocab])].sort((a, b) =>
        a.localeCompare(b)
      ),
      interpretationStatus: current.reprocessRequestedAt ? "reprocessed" : "auto-generated",
      proposalError: undefined,
      proposedAt,
      updatedAt: proposedAt,
      reprocessRequestedAt: undefined,
    }));
    console.log(
      `[WDYT] proposal ready reviewId=${processingReviewId} descriptor=${JSON.stringify(updatedUnit?.proposedDescriptor ?? proposal.proposedDescriptor)}`
    );
  } catch (error) {
    const proposalError = error instanceof Error ? error.message : "Unknown proposal error";
    await patchReviewUnit(processingReviewId, (current) => ({
      ...current,
      proposalState: "error",
      proposalError,
      updatedAt: Date.now(),
    }));
    console.warn(`[WDYT] proposal failed reviewId=${processingReviewId}`, proposalError);
  }
}

export async function queueProposalProcessing() {
  if (processingQueue) {
    console.log("[WDYT] proposal worker already running");
    return;
  }

  processingQueue = true;
  console.log("[WDYT] proposal worker started");
  logProcessMemoryUsage("proposal-worker:start");

  try {
    const reviewUnits = await loadReviewUnits();
    const stalledUnits = reviewUnits.filter((unit) => unit.proposalState === "processing");
    if (stalledUnits.length > 0) {
      const stalledIds = new Set(stalledUnits.map((unit) => unit.reviewId));
      await saveReviewUnits(
        reviewUnits.map((unit) =>
          stalledIds.has(unit.reviewId)
            ? {
                ...unit,
                proposalState: "pending",
                updatedAt: Date.now(),
              }
            : unit
        )
      );
    }

    while (true) {
      const reviewUnits = await loadReviewUnits();
      const vocabulary = await loadVocabulary();
      const stats = buildGlobalVocabStats(reviewUnits, vocabulary);
      const semanticIndex = buildSemanticIndex(reviewUnits, vocabulary, stats);
      const pendingUnits = reviewUnits.filter((unit) => unit.proposalState === "pending" || unit.proposalState === "error");

      if (pendingUnits.length === 0) {
        console.log("[WDYT] proposal worker idle");
        logProcessMemoryUsage("proposal-worker:idle");
        break;
      }

      const concurrency = Math.min(getProposalWorkerConcurrency(), pendingUnits.length);
      console.log(`[WDYT] proposal worker batch count=${pendingUnits.length} concurrency=${concurrency}`);
      logProcessMemoryUsage(`proposal-worker:batch-start pending=${pendingUnits.length} concurrency=${concurrency}`);

      let nextIndex = 0;
      const workers = Array.from({ length: concurrency }, async () => {
        while (true) {
          const unit = pendingUnits[nextIndex];
          nextIndex += 1;
          if (!unit) {
            return;
          }

          await processProposalUnit(unit, vocabulary, stats, semanticIndex);
        }
      });

      await Promise.all(workers);
      logProcessMemoryUsage(`proposal-worker:batch-end pending=${pendingUnits.length} concurrency=${concurrency}`);
    }
  } finally {
    processingQueue = false;
    console.log("[WDYT] proposal worker stopped");
    logProcessMemoryUsage("proposal-worker:stop");
  }
}

export async function refreshReviewUnits() {
  console.log("[WDYT] refreshing review units");
  logProcessMemoryUsage("review-refresh:start");
  await buildReviewUnits({ preserveExisting: true });
  void queueProposalProcessing();
  logProcessMemoryUsage("review-refresh:queued");
}

export async function saveReviewUnitEdits(input: {
  reviewId: string;
  descriptor: string;
  vocab: string[];
  notes?: string;
}) {
  console.log(`[WDYT] saving review unit edits reviewId=${input.reviewId}`);
  const reviewUnits = await loadReviewUnits();
  const reviewUnit = reviewUnits.find((unit) => unit.reviewId === input.reviewId);

  if (!reviewUnit) {
    return null;
  }

  const vocabulary = await loadVocabulary();
  const promotedTerms = [...new Set((input.vocab ?? []).map((term) => term.trim()).filter(Boolean))];
  const now = Date.now();

  for (const term of promotedTerms) {
    const existing = vocabulary.find((entry) => entry.term === term);
    if (existing) {
      existing.status = "approved";
      existing.updatedAt = now;
    } else {
      vocabulary.push({
        term,
        status: "approved",
        updatedAt: now,
      });
    }
  }

  reviewUnit.activeDescriptor = input.descriptor.trim() || reviewUnit.activeDescriptor || reviewUnit.proposedDescriptor;
  reviewUnit.notes = input.notes;
  reviewUnit.updatedAt = now;
  reviewUnit.interpretationStatus = "edited";

  const normalizedActive = normalizeProposedVocabulary(promotedTerms, vocabulary);
  reviewUnit.activeVocab = [...new Set([...normalizedActive.approvedVocab, ...normalizedActive.proposedVocab])].sort((a, b) =>
    a.localeCompare(b)
  );
  reviewUnit.prerequisiteTerms = [];
  reviewUnit.primaryTerms = [...reviewUnit.activeVocab];
  reviewUnit.outcomeTerms = [];
  reviewUnit.uncertainTerms = [];
  reviewUnit.evidenceItems = [];
  reviewUnit.conceptResolutions = [];
  reviewUnit.roleEvidence = {
    prerequisiteTerms: [],
    primaryTerms: [...reviewUnit.activeVocab],
    rationale: ["manual edit"],
  };
  reviewUnit.overlapTerms = deriveOverlapTerms(reviewUnit, reviewUnit.activeVocab, vocabulary);
  reviewUnit.approvedVocabUsed = normalizedActive.approvedVocab;
  reviewUnit.proposedVocab = normalizedActive.proposedVocab;

  await writeJsonFile(getVocabularyPath(), vocabulary.sort((a, b) => a.term.localeCompare(b.term)));
  await saveReviewUnits(reviewUnits);
  console.log(`[WDYT] review unit edits saved reviewId=${input.reviewId}`);
  return reviewUnit;
}

export async function requestReviewUnitReprocess(reviewId: string) {
  const reviewUnits = await loadReviewUnits();
  const reviewUnit = reviewUnits.find((unit) => unit.reviewId === reviewId);

  if (!reviewUnit) {
    return null;
  }

  reviewUnit.proposalState = "pending";
  reviewUnit.proposalError = undefined;
  reviewUnit.prerequisiteTerms = [];
  reviewUnit.primaryTerms = [];
  reviewUnit.outcomeTerms = [];
  reviewUnit.uncertainTerms = [];
  reviewUnit.evidenceItems = [];
  reviewUnit.conceptResolutions = [];
  reviewUnit.roleEvidence = undefined;
  reviewUnit.reprocessRequestedAt = Date.now();
  reviewUnit.updatedAt = reviewUnit.reprocessRequestedAt;
  await saveReviewUnits(reviewUnits);
  void queueProposalProcessing();
  return reviewUnit;
}

export async function upsertVocabulary(input: {
  term: string;
  status?: VocabularyEntry["status"];
  description?: string;
  aliases?: string[];
}) {
  const term = input.term.trim();
  if (!term) {
    return null;
  }

  console.log(`[WDYT] upserting vocabulary term=${term} status=${input.status ?? "approved"}`);

  const vocabulary = await loadVocabulary();
  const now = Date.now();
  const existing = vocabulary.find((entry) => entry.term === term);

  if (existing) {
    existing.status = input.status ?? existing.status;
    existing.description = input.description ?? existing.description;
    existing.aliases = input.aliases ?? existing.aliases;
    existing.updatedAt = now;
  } else {
    vocabulary.push({
      term,
      status: input.status ?? "approved",
      description: input.description,
      aliases: input.aliases,
      updatedAt: now,
    });
  }

  await writeJsonFile(getVocabularyPath(), vocabulary.sort((a, b) => a.term.localeCompare(b.term)));
  await refreshReviewUnits();
  return vocabulary.find((entry) => entry.term === term) ?? null;
}
