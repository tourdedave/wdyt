import { inferSourceAwareTermCandidates } from "./flow-suppression.js";
import { dedupeFlowTermCandidates } from "./semantic-index.js";
import type {
  FlowEvidenceBucket,
  FlowEvidenceItem,
  FlowEvidenceKind,
  FlowTermCandidate,
  FlowTermSource,
  ResolvedFlowConcept,
  SemanticIndex,
  VocabStats,
  VocabularyEntry,
} from "./types.js";
import { canonicalizeConceptTerm, normalizeVocabularyValue } from "./vocabulary.js";
import { resolveFlowConcepts } from "./concept-resolver.js";

type RawEvidenceInput = {
  setupValues: string[];
  actionValues: string[];
  endStateValues: string[];
};

function parseTargetValue(value: string) {
  const match = value.match(/^([a-z]+)\("?(.*?)"?\)$/i);
  if (!match) {
    return null;
  }

  return {
    tag: match[1].toLowerCase(),
    text: match[2].trim(),
  };
}

function canonicalizeResolvedConceptLabel(term: string, vocabulary: Iterable<VocabularyEntry>, rawTerms: string[] = []) {
  let normalized = normalizeVocabularyValue(term);
  if (!normalized) {
    return null;
  }

  const normalizedRawTerms = rawTerms.map((value) => normalizeVocabularyValue(value)).filter(Boolean);

  if (normalized.includes("no results") || normalizedRawTerms.some((value) => value.includes("no results"))) {
    return "no results";
  }

  normalized = normalized
    .replace(/^user\s+/g, "")
    .replace(/^perform\s+/g, "")
    .replace(/^view(?:ing)?\s+/g, "")
    .replace(/\s+(?:page|view|action|navigation|submission|display)$/g, "")
    .trim();

  if (!normalized) {
    return null;
  }

  if (normalized.includes("sign in") || normalized.includes("login")) {
    return "login";
  }

  if (normalized.includes("sign out") || normalized.includes("logout")) {
    return "logout";
  }

  if (normalized.includes("search results")) {
    return "search results";
  }

  if (normalized === "dashboard page") {
    return "dashboard";
  }

  if (normalized === "login page") {
    return "login";
  }

  if (normalized === "reports page") {
    return "reports";
  }

  if (normalized === "settings page") {
    return "settings";
  }

  if (normalized === "workspace details view") {
    return "workspace details";
  }

  const builtin = canonicalizeConceptTerm(normalized, vocabulary);
  return builtin ?? normalized;
}

const OPERATIONAL_PRIMITIVE_PATTERNS = [
  /\b(?:button|click|form|submission|submit|field)\b/,
  /\b(?:input|entry|text entry)\b/,
  /^(?:enter|initiate|submit)\s+/,
  /\bcredential(?:s)?\b/,
  /\blink\b/,
];

function isOperationalPrimitiveTerm(term: string) {
  const normalized = normalizeVocabularyValue(term);
  if (!normalized) {
    return false;
  }

  return OPERATIONAL_PRIMITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function compactActionTargets(targets: string[]) {
  const directTargets: string[] = [];
  const formLabels: string[] = [];
  let sawInput = false;

  for (const target of targets) {
    const parsed = parseTargetValue(target);
    if (!parsed) {
      directTargets.push(target);
      continue;
    }

    if (parsed.tag === "input" || parsed.tag === "textarea") {
      sawInput = true;
      continue;
    }

    if (parsed.tag === "form") {
      if (parsed.text) {
        formLabels.push(parsed.text);
      }
      directTargets.push(target);
      continue;
    }

    directTargets.push(target);
  }

  if (!sawInput) {
    return directTargets;
  }

  const normalizedForms = formLabels
    .map((label) => normalizeVocabularyValue(label))
    .filter(Boolean);

  const syntheticInputs: string[] = [];
  const addSynthetic = (label: string) => {
    if (!syntheticInputs.includes(label)) {
      syntheticInputs.push(label);
    }
  };

  for (const formLabel of normalizedForms) {
    if (formLabel.includes("username") || formLabel.includes("password") || formLabel.includes("sign in")) {
      addSynthetic('input("credentials")');
    }
    if (formLabel.includes("search query") || formLabel.includes("search")) {
      addSynthetic('input("search query")');
    }
  }

  if (syntheticInputs.length === 0) {
    addSynthetic('input("text entry")');
  }

  return [...directTargets, ...syntheticInputs];
}

function clampConfidence(value: unknown, fallback: number) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, value));
}

function bucketToSource(bucket: Exclude<FlowEvidenceBucket, "noise">): FlowTermSource {
  return bucket;
}

function dedupeNeighbors(term: string, semanticIndex: SemanticIndex, sources: FlowTermSource[]) {
  const neighbors = new Map<string, ReturnType<SemanticIndex["search"]>[number]>();

  for (const source of sources) {
    for (const neighbor of semanticIndex.search({ term, source }, 5)) {
      const current = neighbors.get(neighbor.term);
      if (!current || neighbor.score > current.score) {
        neighbors.set(neighbor.term, neighbor);
      }
    }
  }

  return [...neighbors.values()]
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
    .slice(0, 5);
}

function parseBucket(value: unknown, fallback: FlowEvidenceBucket): FlowEvidenceBucket {
  return value === "setup" || value === "action" || value === "end-state" || value === "noise"
    ? value
    : fallback;
}

function parseKind(value: unknown): FlowEvidenceKind | null {
  return value === "url" || value === "target" || value === "title" || value === "heading" || value === "alert"
    ? value
    : null;
}

export function collectRawEvidenceItems(input: RawEvidenceInput): FlowEvidenceItem[] {
  const items: FlowEvidenceItem[] = [];

  const pushItems = (values: string[], kind: FlowEvidenceKind, inferredBucket: Exclude<FlowEvidenceBucket, "noise">) => {
    for (const value of values) {
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      items.push({
        id: `${inferredBucket}:${kind}:${items.length}`,
        kind,
        value: trimmed,
        inferredBucket,
        bucket: inferredBucket,
        confidence: 0.5,
      });
    }
  };

  pushItems(input.setupValues, "url", "setup");
  pushItems(input.actionValues, "target", "action");
  pushItems(input.endStateValues, "url", "end-state");

  return items.map((item) => {
    if (item.kind !== "url") {
      return item;
    }

    try {
      const parsed = new URL(item.value);
      if (item.inferredBucket === "end-state") {
        return { ...item, kind: "url" };
      }
      return { ...item, kind: "url", value: parsed.toString() };
    } catch {
      return item;
    }
  });
}

export function collectStructuredEvidenceItems(input: {
  setupUrls: string[];
  actionTargets: string[];
  finalUrls: string[];
  titles: string[];
  headings: string[];
  alerts: string[];
}) {
  const items: FlowEvidenceItem[] = [];

  const pushItems = (values: string[], kind: FlowEvidenceKind, inferredBucket: Exclude<FlowEvidenceBucket, "noise">) => {
    for (const value of values) {
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      items.push({
        id: `${inferredBucket}:${kind}:${items.length}`,
        kind,
        value: trimmed,
        inferredBucket,
        bucket: inferredBucket,
        confidence: 0.5,
      });
    }
  };

  pushItems(input.setupUrls, "url", "setup");
  pushItems(compactActionTargets(input.actionTargets), "target", "action");
  pushItems(input.finalUrls, "url", "end-state");
  pushItems(input.titles, "title", "end-state");
  pushItems(input.headings, "heading", "end-state");
  pushItems(input.alerts, "alert", "end-state");

  return items;
}

export function normalizeEvidenceClassification(
  value: unknown,
  fallbackItems: FlowEvidenceItem[]
) {
  if (!value || typeof value !== "object") {
    return fallbackItems;
  }

  const candidate = value as Record<string, unknown>;
  const assignments = Array.isArray(candidate.items) ? candidate.items : [];
  const byId = new Map(fallbackItems.map((item) => [item.id, item]));

  const normalized = fallbackItems.map((item) => ({ ...item }));

  for (const assignment of assignments) {
    if (!assignment || typeof assignment !== "object") {
      continue;
    }

    const entry = assignment as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : "";
    const current = byId.get(id);
    if (!current) {
      continue;
    }

    const index = normalized.findIndex((item) => item.id === id);
    if (index < 0) {
      continue;
    }

    normalized[index] = {
      ...current,
      bucket: parseBucket(entry.bucket, current.inferredBucket),
      confidence: clampConfidence(entry.confidence, current.confidence),
      rationale: typeof entry.rationale === "string" ? entry.rationale.trim() : undefined,
    };
  }

  return normalized;
}

export function partitionEvidenceItems(items: FlowEvidenceItem[]) {
  const bucketValues = {
    setupValues: [] as string[],
    actionValues: [] as string[],
    endStateValues: [] as string[],
  };

  for (const item of items) {
    if (item.bucket === "setup") {
      bucketValues.setupValues.push(item.value);
    } else if (item.bucket === "action") {
      bucketValues.actionValues.push(item.value);
    } else if (item.bucket === "end-state") {
      bucketValues.endStateValues.push(item.value);
    }
  }

  return bucketValues;
}

export function buildEvidenceCandidates(
  items: FlowEvidenceItem[],
  registryTerms: string[],
  globalStats: Map<string, VocabStats>,
  vocabulary: Iterable<VocabularyEntry>
) {
  return dedupeFlowTermCandidates(
    inferSourceAwareTermCandidates(
      {
        ...partitionEvidenceItems(items),
        registryTerms,
      },
      globalStats,
      vocabulary
    )
  );
}

export function normalizeConceptResolution(input: {
  value: unknown;
  evidenceItems: FlowEvidenceItem[];
  fallbackCandidates: FlowTermCandidate[];
  semanticIndex: SemanticIndex;
  vocabulary: Iterable<VocabularyEntry>;
}) {
  const itemsById = new Map(input.evidenceItems.map((item) => [item.id, item]));
  const fallback = resolveFlowConcepts({
    candidates: input.fallbackCandidates,
    semanticIndex: input.semanticIndex,
    vocabulary: input.vocabulary,
  });

  if (!input.value || typeof input.value !== "object") {
    return fallback;
  }

  const candidate = input.value as Record<string, unknown>;
  const concepts = Array.isArray(candidate.concepts) ? candidate.concepts : [];
  const resolved: ResolvedFlowConcept[] = [];

  for (const concept of concepts) {
    if (!concept || typeof concept !== "object") {
      continue;
    }

    const entry = concept as Record<string, unknown>;
    const rawTerm = typeof entry.term === "string" ? entry.term.trim() : "";
    const supportingItemIds = Array.isArray(entry.itemIds)
      ? entry.itemIds.map((value) => String(value).trim()).filter(Boolean)
      : [];

    const supportingItems = supportingItemIds
      .map((id) => itemsById.get(id))
      .filter((item): item is FlowEvidenceItem => item !== undefined && item.bucket !== "noise");

    if (!rawTerm || supportingItems.length === 0) {
      continue;
    }

    const builtinTerm = canonicalizeConceptTerm(rawTerm, input.vocabulary);
    const normalizedTerm = builtinTerm ?? normalizeVocabularyValue(rawTerm);
    if (!normalizedTerm) {
      continue;
    }

    const sources = [...new Set(
      supportingItems
        .map((item) => item.bucket)
        .filter((bucket): bucket is Exclude<FlowEvidenceBucket, "noise"> => bucket !== "noise")
        .map(bucketToSource)
    )].sort((a, b) => a.localeCompare(b)) as FlowTermSource[];

    if (sources.length === 0) {
      continue;
    }

    resolved.push({
      term: normalizedTerm,
      rawTerms: [...new Set(supportingItems.map((item) => normalizeVocabularyValue(item.value)).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
      ),
      sources,
      confidence: clampConfidence(entry.confidence, 0.7),
      strategy: "llm-resolved",
      neighbors: dedupeNeighbors(normalizedTerm, input.semanticIndex, sources),
      supportingItemIds: supportingItems.map((item) => item.id).sort((a, b) => a.localeCompare(b)),
    });
  }

  if (resolved.length === 0) {
    return fallback;
  }

  const grouped = new Map<string, ResolvedFlowConcept>();

  for (const concept of resolved) {
    const canonicalTerm = canonicalizeResolvedConceptLabel(
      concept.term,
      input.vocabulary,
      concept.rawTerms
    );
    if (!canonicalTerm) {
      continue;
    }

    const current = grouped.get(canonicalTerm);
    if (!current) {
      grouped.set(canonicalTerm, {
        ...concept,
        term: canonicalTerm,
      });
      continue;
    }

    const sourceSet = new Set<FlowTermSource>([...current.sources, ...concept.sources]);
    const rawTermSet = new Set<string>([...current.rawTerms, ...concept.rawTerms, concept.term]);
    const itemIdSet = new Set<string>([
      ...(current.supportingItemIds ?? []),
      ...(concept.supportingItemIds ?? []),
    ]);
    const neighborMap = new Map<string, (typeof current.neighbors)[number]>();
    for (const neighbor of [...current.neighbors, ...concept.neighbors]) {
      const existing = neighborMap.get(neighbor.term);
      if (!existing || neighbor.score > existing.score) {
        neighborMap.set(neighbor.term, neighbor);
      }
    }

    grouped.set(canonicalTerm, {
      term: canonicalTerm,
      rawTerms: [...rawTermSet].sort((a, b) => a.localeCompare(b)),
      sources: [...sourceSet].sort((a, b) => a.localeCompare(b)) as FlowTermSource[],
      confidence: Math.max(current.confidence, concept.confidence),
      strategy: current.strategy === "llm-resolved" || concept.strategy === "llm-resolved"
        ? "llm-resolved"
        : current.strategy,
      neighbors: [...neighborMap.values()]
        .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
        .slice(0, 5),
      supportingItemIds: [...itemIdSet].sort((a, b) => a.localeCompare(b)),
    });
  }

  return [...grouped.values()].sort((a, b) => a.term.localeCompare(b.term));
}

export function filterResolvedConcepts(concepts: ResolvedFlowConcept[]) {
  const termSet = new Set(concepts.map((concept) => concept.term));
  const hasHighValueConcept = concepts.some(
    (concept) => !isOperationalPrimitiveTerm(concept.term) && (concept.sources.includes("action") || concept.sources.includes("end-state"))
  );

  return concepts.filter((concept) => {
    if (concept.sources.includes("end-state")) {
      return true;
    }

    if (!hasHighValueConcept || !isOperationalPrimitiveTerm(concept.term)) {
      return true;
    }

    const normalized = normalizeVocabularyValue(concept.term);
    if (!normalized) {
      return true;
    }

    if (normalized.includes("credential")) {
      return !termSet.has("login");
    }

    if (normalized.includes("search")) {
      return !termSet.has("search") && !termSet.has("search results") && !termSet.has("no results");
    }

    return false;
  });
}
