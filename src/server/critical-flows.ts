import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getCriticalFlowsPath, getVocabularyPath, readJsonFile, writeJsonFile } from "../shared/fs.js";
import type {
  ApprovedDescriptorRecord,
  CriticalFlowDetailRecord,
  CriticalFlowRecord,
  CriticalFlowStatus,
  ParsedCriticalFlow,
  StructuredBehavior,
  VocabularyEntry,
} from "../shared/types.js";
import {
  canonicalizeSemanticTerms,
  getApprovedVocabulary,
  resolveApprovedVocabularyTerm,
} from "../shared/vocabulary.js";
import { getRequiredLlmConfig, requestJsonCompletion } from "./llm.js";
import { loadReviewUnits } from "./review.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const criticalFlowSystemPromptPath = path.join(__dirname, "../prompts/critical-flow-system-prompt.txt");
const CRITICAL_FLOW_SCHEMA_RETRY_LIMIT = 2;
const QUALIFIER_PREFIX_PATTERN = /\b(?:using|with|via|from)\s+([^,.;]+)/gi;
const LEADING_BEHAVIOR_PREFIX_PATTERN =
  /^(?:user can|users can|should be able to|can|be able to|allow(?:s|ed)?(?: users)? to)\s+/i;

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function normalizeTerm(term: string, vocabulary: Iterable<VocabularyEntry>) {
  const approvedTerm = resolveApprovedVocabularyTerm(term, vocabulary);
  return approvedTerm ?? term.trim();
}

function normalizeBehaviorLabel(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeQualifierToken(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function formatQualifierToken(value: string) {
  return value.replaceAll("_", " ");
}

function normalizeStructuredBehavior(value: unknown, vocabulary: Iterable<VocabularyEntry>): StructuredBehavior | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const rawAction = typeof candidate.action === "string" ? normalizeBehaviorLabel(candidate.action) : "";
  const qualifiers = normalizeStringList(candidate.qualifiers)
    .map((qualifier) => normalizeQualifierToken(qualifier))
    .filter(Boolean);

  if (!rawAction) {
    return undefined;
  }

  return {
    action: normalizeTerm(rawAction, vocabulary),
    qualifiers: [...new Set(qualifiers)].sort((a, b) => a.localeCompare(b)),
  };
}

function decomposeBehaviorPhrase(
  value: string,
  vocabulary: Iterable<VocabularyEntry>,
  candidateActions: string[] = []
): StructuredBehavior | undefined {
  const raw = value.trim();
  if (!raw) {
    return undefined;
  }

  const qualifiers = [...raw.matchAll(QUALIFIER_PREFIX_PATTERN)]
    .map((match) => normalizeQualifierToken(match[1] ?? ""))
    .filter(Boolean);
  const dedupedQualifiers = [...new Set(qualifiers)];
  if (dedupedQualifiers.length === 0) {
    return undefined;
  }

  const actionSource = raw
    .replace(LEADING_BEHAVIOR_PREFIX_PATTERN, "")
    .replace(QUALIFIER_PREFIX_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:]+$/g, "");
  const normalizedActionSource = normalizeBehaviorLabel(actionSource);
  if (!normalizedActionSource) {
    return undefined;
  }

  const normalizedCandidates = candidateActions
    .map((candidate) => normalizeBehaviorLabel(candidate))
    .filter(Boolean);
  if (normalizedCandidates.length > 0 && !normalizedCandidates.includes(normalizedActionSource)) {
    return undefined;
  }

  const canonicalAction = normalizeTerm(normalizedActionSource, vocabulary);
  return {
    action: canonicalAction,
    qualifiers: dedupedQualifiers.sort((a, b) => a.localeCompare(b)),
  };
}

function normalizeParsedCriticalFlow(
  value: unknown,
  rawText: string,
  vocabulary: VocabularyEntry[],
  options: { preserveInterpretedTerms?: boolean } = {}
): ParsedCriticalFlow | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : rawText.trim();
  const interpretedSteps = normalizeStringList(candidate.interpretedSteps).map((step) => normalizeTerm(step, vocabulary));
  const rawInterpretedTerms = normalizeStringList(candidate.interpretedTerms);
  const interpretedTerms = options.preserveInterpretedTerms
    ? rawInterpretedTerms
    : rawInterpretedTerms.map((term) => normalizeTerm(term, vocabulary));
  const outcome = typeof candidate.outcome === "string" ? candidate.outcome.trim() : undefined;
  const structuredBehavior = normalizeStructuredBehavior(candidate.behavior, vocabulary);

  if (!name || interpretedSteps.length === 0 || interpretedTerms.length === 0) {
    return null;
  }

  return {
    name,
    rawText: rawText.trim(),
    interpretedSteps: [...new Set(interpretedSteps)].filter(Boolean),
    interpretedTerms: options.preserveInterpretedTerms
      ? [...new Set(interpretedTerms)].filter(Boolean)
      : canonicalizeSemanticTerms(interpretedTerms, vocabulary),
    outcome: outcome || undefined,
    behavior:
      structuredBehavior ??
      decomposeBehaviorPhrase(rawText, vocabulary, [...interpretedSteps, ...interpretedTerms]) ??
      decomposeBehaviorPhrase(name, vocabulary, [...interpretedSteps, ...interpretedTerms]),
  };
}

async function loadVocabulary() {
  return readJsonFile<VocabularyEntry[]>(getVocabularyPath(), []);
}

async function saveCriticalFlows(flows: CriticalFlowRecord[]) {
  await writeJsonFile(getCriticalFlowsPath(), flows.sort((a, b) => a.name.localeCompare(b.name)));
}

export async function loadCriticalFlows() {
  return readJsonFile<CriticalFlowRecord[]>(getCriticalFlowsPath(), []);
}

function normalizeDescriptorTerms(terms: string[], vocabulary: VocabularyEntry[]) {
  return canonicalizeSemanticTerms(terms, vocabulary);
}

function buildDescriptorComparisonTerms(
  unit: Awaited<ReturnType<typeof loadReviewUnits>>[number],
  vocabulary: VocabularyEntry[]
) {
  const roleTerms = [
    ...(unit.primaryTerms ?? []),
    ...(unit.outcomeTerms ?? []),
  ];

  const normalizedRoleTerms = normalizeDescriptorTerms(roleTerms, vocabulary);
  if (normalizedRoleTerms.length > 0) {
    const supplementalTerms = normalizeDescriptorTerms(
      unit.activeVocab ?? [...(unit.approvedVocabUsed ?? []), ...(unit.proposedVocab ?? [])],
      vocabulary
    );

    return [...new Set([...normalizedRoleTerms, ...supplementalTerms])].sort((a, b) => a.localeCompare(b));
  }

  return normalizeDescriptorTerms(unit.activeVocab ?? [...(unit.approvedVocabUsed ?? []), ...(unit.proposedVocab ?? [])], vocabulary);
}

export async function loadApprovedDescriptors() {
  const units = await loadReviewUnits();
  const vocabulary = await loadVocabulary();

  return units
    .filter((unit) => unit.proposalState === "proposed" && (unit.activeDescriptor || unit.proposedDescriptor))
    .map(
      (unit): ApprovedDescriptorRecord => ({
        id: unit.reviewId,
        name: unit.activeDescriptor || unit.proposedDescriptor || unit.canonical.join(" → "),
        vocab: buildDescriptorComparisonTerms(unit, vocabulary),
        behavior: decomposeBehaviorPhrase(
          unit.activeDescriptor || unit.proposedDescriptor || unit.canonical.join(" → "),
          vocabulary,
          buildDescriptorComparisonTerms(unit, vocabulary)
        ),
      })
    )
    .filter((descriptor) => descriptor.name.trim().length > 0);
}

function computeCoverage(
  flow: Pick<CriticalFlowRecord, "interpretedTerms" | "behavior">,
  descriptors: ApprovedDescriptorRecord[]
): {
  status: CriticalFlowStatus;
  matchedDescriptorIds: string[];
  matchedConcepts: string[];
  missingTerms: string[];
  matchedAction?: string;
  missingQualifiers: string[];
} {
  if (flow.behavior?.action && flow.behavior.qualifiers.length > 0) {
    const expectedAction = normalizeBehaviorLabel(flow.behavior.action);
    const expectedQualifiers = [...new Set(flow.behavior.qualifiers.map((qualifier) => normalizeQualifierToken(qualifier)).filter(Boolean))];
    let bestMatch:
      | {
          descriptorId: string;
          status: CriticalFlowStatus;
          matchedAction?: string;
          missingQualifiers: string[];
        }
      | null = null;

    for (const descriptor of descriptors) {
      const descriptorBehavior = descriptor.behavior;
      const descriptorAction = normalizeBehaviorLabel(descriptorBehavior?.action ?? "");
      const descriptorTokens = new Set(
        [
          ...(descriptorBehavior?.qualifiers ?? []),
          ...descriptor.vocab,
        ]
          .map((value) => normalizeQualifierToken(value))
          .filter(Boolean)
      );
      const actionMatches =
        descriptorAction === expectedAction ||
        descriptor.vocab.some((term) => normalizeBehaviorLabel(term) === expectedAction);

      if (!actionMatches) {
        continue;
      }

      const missingQualifiers = expectedQualifiers.filter((qualifier) => !descriptorTokens.has(qualifier));
      const status: CriticalFlowStatus = missingQualifiers.length === 0 ? "covered" : "partial";
      const candidate = {
        descriptorId: descriptor.id,
        status,
        matchedAction: descriptorBehavior?.action ?? descriptor.name,
        missingQualifiers,
      };

      if (!bestMatch) {
        bestMatch = candidate;
        continue;
      }

      const currentScore = bestMatch.status === "covered" ? 2 : 1;
      const nextScore = candidate.status === "covered" ? 2 : 1;
      if (
        nextScore > currentScore ||
        (nextScore === currentScore && candidate.missingQualifiers.length < bestMatch.missingQualifiers.length)
      ) {
        bestMatch = candidate;
      }
    }

    if (bestMatch) {
      return {
        status: bestMatch.status,
        matchedDescriptorIds: [bestMatch.descriptorId],
        matchedConcepts: bestMatch.status === "covered" ? [flow.behavior.action, ...expectedQualifiers.map(formatQualifierToken)] : [flow.behavior.action],
        missingTerms: bestMatch.missingQualifiers.map(formatQualifierToken),
        matchedAction: bestMatch.matchedAction,
        missingQualifiers: bestMatch.missingQualifiers,
      };
    }

    return {
      status: "not_covered",
      matchedDescriptorIds: [],
      matchedConcepts: [],
      missingTerms: [flow.behavior.action, ...expectedQualifiers.map(formatQualifierToken)],
      missingQualifiers: expectedQualifiers,
    };
  }

  const normalizedFlowTerms = [...new Set(flow.interpretedTerms.map((term) => term.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
  const remainingTerms = new Set(normalizedFlowTerms);
  const matchedDescriptorIds: string[] = [];

  // TODO: Replace this greedy term-coverage pass with graph- or telemetry-aware matching.
  // TODO: Use telemetry evidence as an additional source of matching alongside reviewed descriptors.
  const rankedDescriptors = [...descriptors].sort((a, b) => b.vocab.length - a.vocab.length || a.name.localeCompare(b.name));

  for (const descriptor of rankedDescriptors) {
    const matchingTerms = descriptor.vocab.filter((term) => remainingTerms.has(term));
    if (matchingTerms.length === 0) {
      continue;
    }

    matchedDescriptorIds.push(descriptor.id);
    for (const term of matchingTerms) {
      remainingTerms.delete(term);
    }
  }

  const matchedDescriptorSet = new Set(matchedDescriptorIds);
  const matchedTermUnion = new Set(
    descriptors
      .filter((descriptor) => matchedDescriptorSet.has(descriptor.id))
      .flatMap((descriptor) => descriptor.vocab)
      .filter((term) => normalizedFlowTerms.includes(term))
  );
  const matchedConcepts = normalizedFlowTerms.filter((term) => matchedTermUnion.has(term));
  const missingTerms = normalizedFlowTerms.filter((term) => !matchedTermUnion.has(term));
  const matchedCount = matchedConcepts.length;
  const status: CriticalFlowStatus =
    matchedCount === 0 ? "not_covered" : missingTerms.length === 0 ? "covered" : "partial";

  return {
    status,
    matchedDescriptorIds,
    matchedConcepts,
    missingTerms,
    missingQualifiers: [],
  };
}

export async function refreshCriticalFlowCoverage() {
  const [flows, descriptors] = await Promise.all([loadCriticalFlows(), loadApprovedDescriptors()]);
  const now = Date.now();

  const updated = flows.map((flow) => {
    const coverage = computeCoverage(flow, descriptors);
    return {
      ...flow,
      status: coverage.status,
      matchedDescriptorIds: coverage.matchedDescriptorIds,
      updatedAt: now,
    };
  });

  await saveCriticalFlows(updated);
  return updated;
}

export async function parseCriticalFlow(rawText: string): Promise<ParsedCriticalFlow> {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error("Critical flow text is required.");
  }

  const vocabulary = await loadVocabulary();
  const descriptorSuggestion = await resolveDescriptorSuggestion(trimmed, vocabulary);
  if (descriptorSuggestion) {
    return descriptorSuggestion;
  }
  const approvedVocabulary = getApprovedVocabulary(vocabulary).map((entry) => ({
    term: entry.term,
    description: entry.description ?? null,
    aliases: entry.aliases ?? [],
  }));
  const systemPrompt = await readFile(criticalFlowSystemPromptPath, "utf8");
  const userPrompt = JSON.stringify(
    {
      rawText: trimmed,
      approvedVocabularyRegistry: approvedVocabulary,
    },
    null,
    2
  );

  for (let attempt = 0; attempt < CRITICAL_FLOW_SCHEMA_RETRY_LIMIT; attempt += 1) {
    const llmConfig = getRequiredLlmConfig();
    const parsed = normalizeParsedCriticalFlow(
      await requestJsonCompletion({
        baseUrl: llmConfig?.baseUrl ?? "",
        apiKey: llmConfig?.apiKey ?? "",
        model: llmConfig?.model ?? "",
        systemPrompt,
        userPrompt,
      }),
      trimmed,
      vocabulary
    );

    if (parsed) {
      return parsed;
    }
  }

  throw new Error("LLM response did not match expected critical flow schema");
}

export async function createCriticalFlow(input: ParsedCriticalFlow) {
  const [flows, vocabulary, descriptors] = await Promise.all([loadCriticalFlows(), loadVocabulary(), loadApprovedDescriptors()]);
  const normalized = normalizeParsedCriticalFlow(input, input.rawText, vocabulary, {
    preserveInterpretedTerms: Boolean(input.behavior),
  });

  if (!normalized) {
    throw new Error("Critical flow is missing required interpreted fields.");
  }

  const coverage = computeCoverage(normalized, descriptors);
  const record: CriticalFlowRecord = {
    id: randomUUID(),
    ...normalized,
    status: coverage.status,
    matchedDescriptorIds: coverage.matchedDescriptorIds,
    updatedAt: Date.now(),
  };

  flows.push(record);
  await saveCriticalFlows(flows);
  return record;
}

export async function updateCriticalFlow(id: string, input: ParsedCriticalFlow) {
  const [flows, vocabulary, descriptors] = await Promise.all([loadCriticalFlows(), loadVocabulary(), loadApprovedDescriptors()]);
  const existing = flows.find((flow) => flow.id === id);

  if (!existing) {
    return null;
  }

  const normalized = normalizeParsedCriticalFlow(input, input.rawText, vocabulary, {
    preserveInterpretedTerms: Boolean(input.behavior),
  });
  if (!normalized) {
    throw new Error("Critical flow is missing required interpreted fields.");
  }

  const coverage = computeCoverage(normalized, descriptors);
  existing.name = normalized.name;
  existing.rawText = normalized.rawText;
  existing.interpretedSteps = normalized.interpretedSteps;
  existing.interpretedTerms = normalized.interpretedTerms;
  existing.outcome = normalized.outcome;
  existing.behavior = normalized.behavior;
  existing.status = coverage.status;
  existing.matchedDescriptorIds = coverage.matchedDescriptorIds;
  existing.updatedAt = Date.now();

  await saveCriticalFlows(flows);
  return existing;
}

export async function deleteCriticalFlow(id: string) {
  const flows = await loadCriticalFlows();
  const nextFlows = flows.filter((flow) => flow.id !== id);

  if (nextFlows.length === flows.length) {
    return false;
  }

  await saveCriticalFlows(nextFlows);
  return true;
}

function toSentenceCase(value: string) {
  const trimmed = value.trim().replace(/[.?!]+$/, "");
  if (!trimmed) {
    return trimmed;
  }

  return trimmed[0].toLowerCase() + trimmed.slice(1);
}

function descriptorToSuggestionText(name: string) {
  const lower = name.trim().toLowerCase();
  if (!lower) {
    return "";
  }

  if (lower.includes("sign-in") || lower.includes("sign in") || lower.includes("login")) {
    return "Sign in successfully";
  }

  if (lower.includes("export") && lower.includes("report")) {
    return "Export a report to CSV";
  }

  if (lower.includes("create") && lower.includes("report")) {
    return "Create a report";
  }

  if (lower.includes("settings")) {
    return "Open settings";
  }

  const normalized = name.trim().replace(/[.?!]+$/, "");
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : "";
}

function normalizeSuggestionValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function resolveDescriptorSuggestion(rawText: string, vocabulary: VocabularyEntry[]) {
  const normalizedInput = normalizeSuggestionValue(rawText);
  if (!normalizedInput) {
    return null;
  }

  const descriptors = await loadApprovedDescriptors();
  const sourceDescriptor = descriptors.find(
    (descriptor) => normalizeSuggestionValue(descriptorToSuggestionText(descriptor.name)) === normalizedInput
  );

  if (!sourceDescriptor || sourceDescriptor.vocab.length === 0) {
    return null;
  }

  return normalizeParsedCriticalFlow(
    {
      name: rawText.trim(),
      rawText: rawText.trim(),
      interpretedSteps: sourceDescriptor.vocab,
      interpretedTerms: sourceDescriptor.vocab,
      outcome: "",
      behavior: sourceDescriptor.behavior,
    },
    rawText.trim(),
    vocabulary,
    { preserveInterpretedTerms: true }
  );
}

export async function loadCriticalFlowState() {
  const [flows, descriptors] = await Promise.all([refreshCriticalFlowCoverage(), loadApprovedDescriptors()]);
  const descriptorMap = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const existingFlowLabels = new Set(
    flows.flatMap((flow) => [flow.name, flow.rawText]).map((value) => normalizeSuggestionValue(value)).filter(Boolean)
  );
  const existingFlowTermSets = flows.map((flow) => new Set(flow.interpretedTerms));
  const suggestions = [...new Set(descriptors.map((descriptor) => descriptorToSuggestionText(descriptor.name)).filter(Boolean))]
    .filter((suggestion) => !existingFlowLabels.has(normalizeSuggestionValue(suggestion)))
    .filter((suggestion) => {
      const sourceDescriptor = descriptors.find((descriptor) => descriptorToSuggestionText(descriptor.name) === suggestion);
      if (!sourceDescriptor || sourceDescriptor.vocab.length === 0) {
        return true;
      }

      return !existingFlowTermSets.some((flowTerms) => sourceDescriptor.vocab.every((term) => flowTerms.has(term)));
    })
    .sort((a, b) => a.localeCompare(b));

  const flowsWithDetails: CriticalFlowDetailRecord[] = flows.map((flow) => {
    const coverage = computeCoverage(flow, descriptors);
    return {
      ...flow,
      matchedDescriptors: flow.matchedDescriptorIds
        .map((id) => descriptorMap.get(id))
        .filter((descriptor): descriptor is ApprovedDescriptorRecord => Boolean(descriptor)),
      matchedConcepts: coverage.matchedConcepts,
      missingTerms: coverage.missingTerms,
      matchedAction: coverage.matchedAction,
      missingQualifiers: coverage.missingQualifiers,
    };
  });

  return {
    flows: flowsWithDetails,
    suggestions,
    hasDescriptors: descriptors.length > 0,
  };
}
