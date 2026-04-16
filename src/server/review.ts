import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  FlowDescriptorProposal,
  IngestPayload,
  ProcessedRunRecord,
  ReviewUnitRecord,
  VocabularyEntry,
} from "../shared/types.js";
import {
  findApprovedVocabularyMatches,
  getApprovedVocabulary,
  normalizeOverlapTerms,
  normalizeProposedVocabulary,
  resolveApprovedVocabularyTerm,
} from "../shared/vocabulary.js";
import { scoreProposalConfidence, validateProposal } from "../shared/proposal-validation.js";
import { DEFAULT_LLM_API_KEY, DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL, requestJsonCompletion } from "./llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reviewSystemPromptPath = path.join(__dirname, "../prompts/review-system-prompt.txt");

let processingQueue = false;

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

function hashVariantSignature(signature: string) {
  return createHash("sha256").update(signature).digest("hex").slice(0, 12);
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

async function loadVocabulary() {
  return readJsonFile<VocabularyEntry[]>(getVocabularyPath(), []);
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

function materializeActiveFields(unit: ReviewUnitRecord, vocabulary: VocabularyEntry[]) {
  const normalized = getActiveVocab(unit, vocabulary);
  const activeVocab = [...new Set([...normalized.approvedVocab, ...normalized.proposedVocab])].sort((a, b) => a.localeCompare(b));
  const activeDescriptor = getActiveDescriptor(unit);
  const interpretationStatus = unit.interpretationStatus ?? "auto-generated";

  return {
    ...unit,
    activeDescriptor,
    activeVocab,
    overlapTerms: normalizeOverlapTerms(activeVocab, vocabulary),
    interpretationStatus,
  };
}

async function saveReviewUnits(units: ReviewUnitRecord[]) {
  await writeJsonFile(getReviewUnitsPath(), units.sort((a, b) => a.reviewId.localeCompare(b.reviewId)));
}

export async function loadReviewUnits() {
  const units = await readJsonFile<ReviewUnitRecord[]>(getReviewUnitsPath(), []);
  const vocabulary = await loadVocabulary();
  return units.map((unit) => materializeActiveFields(unit, vocabulary));
}

export async function buildReviewUnits() {
  console.log("[WDYT] rebuilding review units from persisted runs");
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

  const existing = await loadReviewUnits();
  const vocabulary = await loadVocabulary();
  const existingById = new Map(existing.map((unit) => [unit.reviewId, unit]));
  const now = Date.now();

  const materialized: ReviewUnitRecord[] = reviewUnits
    .sort((a, b) => b.count - a.count || a.reviewId.localeCompare(b.reviewId))
    .map((unit) => {
      const previous = existingById.get(unit.reviewId);
      return materializeActiveFields({
        reviewId: unit.reviewId,
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
        proposalState: previous?.proposalState ?? "pending",
        proposedDescriptor: previous?.proposedDescriptor,
        proposedConfidence: previous?.proposedConfidence,
        proposedRationale: previous?.proposedRationale,
        candidateVocab: previous?.candidateVocab,
        approvedVocabUsed: previous?.approvedVocabUsed ?? [],
        proposedVocab: previous?.proposedVocab ?? [],
        activeDescriptor: previous?.activeDescriptor ?? previous?.proposedDescriptor,
        activeVocab: previous?.activeVocab ?? [...new Set([...(previous?.approvedVocabUsed ?? []), ...(previous?.proposedVocab ?? [])])],
        interpretationStatus: previous?.interpretationStatus,
        proposalError: previous?.proposalError,
        notes: previous?.notes,
        updatedAt: now,
        proposedAt: previous?.proposedAt,
        reprocessRequestedAt: previous?.reprocessRequestedAt,
      }, vocabulary);
    });

  await saveReviewUnits(materialized);
  console.log(`[WDYT] review units ready count=${materialized.length}`);
  return materialized;
}

async function proposeDescriptor(unit: ReviewUnitRecord, vocabulary: VocabularyEntry[]) {
  const baseUrl = process.env.WDYT_LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL;
  const model = process.env.WDYT_LLM_MODEL ?? DEFAULT_LLM_MODEL;
  const apiKey = process.env.WDYT_LLM_API_KEY ?? DEFAULT_LLM_API_KEY;
  const systemPrompt = await readFile(reviewSystemPromptPath, "utf8");
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

  const evidence = {
    reviewId: unit.reviewId,
    flowId: unit.flowId,
    variantSignature: unit.variantSignature ?? null,
    canonical: unit.canonical,
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

  async function generateProposal() {
    const parsed = normalizeFlowDescriptorProposal(
      await requestJsonCompletion({
        baseUrl,
        apiKey,
        model,
        systemPrompt,
        userPrompt,
      }),
      vocabulary
    );

    if (!parsed) {
      throw new Error("LLM response did not match expected proposal schema");
    }

    return parsed;
  }

  const parsed = await generateProposal();
  const validation = validateProposal(evidence, parsed, vocabulary);
  const adjustedConfidence = scoreProposalConfidence(evidence, parsed, validation.issues);

  return {
    proposedDescriptor: parsed.descriptor,
    proposedConfidence: adjustedConfidence,
    proposedRationale: parsed.rationale,
    approvedVocabUsed: parsed.approvedVocab,
    proposedVocab: parsed.proposedVocab,
  };
}

export async function queueProposalProcessing() {
  if (processingQueue) {
    console.log("[WDYT] proposal worker already running");
    return;
  }

  processingQueue = true;
  console.log("[WDYT] proposal worker started");

  try {
    while (true) {
      const reviewUnits = await loadReviewUnits();
      const vocabulary = await loadVocabulary();
      const nextUnit = reviewUnits.find((unit) => unit.proposalState === "pending" || unit.proposalState === "error");

      if (!nextUnit) {
        console.log("[WDYT] proposal worker idle");
        break;
      }

      console.log(`[WDYT] proposing descriptor reviewId=${nextUnit.reviewId}`);
      nextUnit.proposalState = "processing";
      nextUnit.proposalError = undefined;
      nextUnit.updatedAt = Date.now();
      await saveReviewUnits(reviewUnits);

      try {
        const proposal = await proposeDescriptor(nextUnit, vocabulary);
        nextUnit.proposalState = "proposed";
        nextUnit.proposedDescriptor = proposal.proposedDescriptor;
        nextUnit.proposedConfidence = proposal.proposedConfidence;
        nextUnit.proposedRationale = proposal.proposedRationale;
        nextUnit.approvedVocabUsed = proposal.approvedVocabUsed;
        nextUnit.proposedVocab = proposal.proposedVocab;
        nextUnit.activeDescriptor = proposal.proposedDescriptor;
        nextUnit.activeVocab = [...new Set([...proposal.approvedVocabUsed, ...proposal.proposedVocab])].sort((a, b) =>
          a.localeCompare(b)
        );
        nextUnit.interpretationStatus = nextUnit.reprocessRequestedAt ? "reprocessed" : "auto-generated";
        nextUnit.proposalError = undefined;
        nextUnit.proposedAt = Date.now();
        nextUnit.updatedAt = nextUnit.proposedAt;
        nextUnit.reprocessRequestedAt = undefined;
        console.log(
          `[WDYT] proposal ready reviewId=${nextUnit.reviewId} descriptor=${JSON.stringify(nextUnit.proposedDescriptor)}`
        );
      } catch (error) {
        nextUnit.proposalState = "error";
        nextUnit.proposalError = error instanceof Error ? error.message : "Unknown proposal error";
        nextUnit.updatedAt = Date.now();
        console.warn(`[WDYT] proposal failed reviewId=${nextUnit.reviewId}`, nextUnit.proposalError);
      }

      await saveReviewUnits(reviewUnits);
    }
  } finally {
    processingQueue = false;
    console.log("[WDYT] proposal worker stopped");
  }
}

export async function refreshReviewUnits() {
  console.log("[WDYT] refreshing review units");
  await buildReviewUnits();
  void queueProposalProcessing();
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
  reviewUnit.overlapTerms = normalizeOverlapTerms(reviewUnit.activeVocab, vocabulary);
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
