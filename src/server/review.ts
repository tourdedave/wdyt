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
  ReviewDecisionStatus,
  ReviewUnitRecord,
  VocabularyEntry,
} from "../shared/types.js";
import {
  findApprovedVocabularyMatches,
  getApprovedVocabulary,
  normalizeProposedVocabulary,
  resolveApprovedVocabularyTerm,
} from "../shared/vocabulary.js";
import { scoreProposalConfidence, validateProposal } from "../shared/proposal-validation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reviewSystemPromptPath = path.join(__dirname, "../prompts/review-system-prompt.txt");
const DEFAULT_LLM_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_LLM_API_KEY = "ollama";
const DEFAULT_LLM_MODEL = "mistral:instruct";

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

async function saveReviewUnits(units: ReviewUnitRecord[]) {
  await writeJsonFile(getReviewUnitsPath(), units.sort((a, b) => a.reviewId.localeCompare(b.reviewId)));
}

export async function loadReviewUnits() {
  return readJsonFile<ReviewUnitRecord[]>(getReviewUnitsPath(), []);
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
  const existingById = new Map(existing.map((unit) => [unit.reviewId, unit]));
  const now = Date.now();

  const materialized: ReviewUnitRecord[] = reviewUnits
    .sort((a, b) => b.count - a.count || a.reviewId.localeCompare(b.reviewId))
    .map((unit) => {
      const previous = existingById.get(unit.reviewId);
      return {
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
        proposalError: previous?.proposalError,
        reviewStatus: previous?.reviewStatus ?? "pending",
        approvedDescriptor: previous?.approvedDescriptor,
        notes: previous?.notes,
        updatedAt: now,
        proposedAt: previous?.proposedAt,
        reviewedAt: previous?.reviewedAt,
      };
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
      const nextUnit = reviewUnits.find(
        (unit) => unit.reviewStatus === "pending" && (unit.proposalState === "pending" || unit.proposalState === "error")
      );

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
        nextUnit.proposalError = undefined;
        nextUnit.proposedAt = Date.now();
        nextUnit.updatedAt = nextUnit.proposedAt;
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

export async function saveReviewDecision(input: {
  reviewId: string;
  reviewStatus: ReviewDecisionStatus;
  approvedDescriptor?: string;
  notes?: string;
  promoteVocab?: string[];
}) {
  console.log(`[WDYT] saving review decision reviewId=${input.reviewId} status=${input.reviewStatus}`);
  const reviewUnits = await loadReviewUnits();
  const reviewUnit = reviewUnits.find((unit) => unit.reviewId === input.reviewId);

  if (!reviewUnit) {
    return null;
  }

  const vocabulary = await loadVocabulary();
  const promotedTerms = [...new Set((input.promoteVocab ?? []).map((term) => term.trim()).filter(Boolean))];
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

  reviewUnit.reviewStatus = input.reviewStatus;
  reviewUnit.approvedDescriptor = input.approvedDescriptor ?? reviewUnit.proposedDescriptor;
  reviewUnit.notes = input.notes;
  reviewUnit.reviewedAt = now;
  reviewUnit.updatedAt = now;

  if (promotedTerms.length > 0) {
    const normalizedProposals = normalizeProposedVocabulary(
      [...new Set([...reviewUnit.proposedVocab, ...promotedTerms])],
      vocabulary
    );
    reviewUnit.approvedVocabUsed = [
      ...new Set([...reviewUnit.approvedVocabUsed, ...normalizedProposals.approvedVocab, ...promotedTerms]),
    ].sort((a, b) => a.localeCompare(b));
    reviewUnit.proposedVocab = normalizedProposals.proposedVocab;
  }

  await writeJsonFile(getVocabularyPath(), vocabulary.sort((a, b) => a.term.localeCompare(b.term)));
  await saveReviewUnits(reviewUnits);
  console.log(`[WDYT] review decision saved reviewId=${input.reviewId}`);
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
