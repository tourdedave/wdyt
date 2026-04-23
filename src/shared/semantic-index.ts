import type { FlowTermCandidate, FlowTermSource, ReviewUnitRecord, SemanticIndex, SemanticIndexQuery, SemanticNeighbor, VocabStats, VocabularyEntry } from "./types.js";
import { canonicalizeSemanticTerms, normalizeVocabularyValue } from "./vocabulary.js";

type IndexedTerm = {
  term: string;
  source: FlowTermSource;
  normalized: string;
  tokens: Set<string>;
  reviewUnitCount?: number;
  descriptorCount?: number;
};

function tokenize(value: string) {
  const normalized = normalizeVocabularyValue(value);
  return new Set(normalized.split(" ").filter(Boolean));
}

function scoreTokenOverlap(left: Set<string>, right: Set<string>) {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let shared = 0;
  for (const token of left) {
    if (right.has(token)) {
      shared += 1;
    }
  }

  return (2 * shared) / (left.size + right.size);
}

function sourceCompatibilityBoost(querySource: FlowTermSource | undefined, candidateSource: FlowTermSource) {
  if (!querySource) {
    return 0;
  }

  if (querySource === candidateSource) {
    return 0.2;
  }

  if (querySource === "end-state" && candidateSource === "historical") {
    return 0.05;
  }

  if (querySource === "action" && candidateSource === "historical") {
    return 0.05;
  }

  return 0;
}

export function createInMemorySemanticIndex(entries: IndexedTerm[]): SemanticIndex {
  return {
    search(query: SemanticIndexQuery, limit = 5) {
      const normalized = normalizeVocabularyValue(query.term);
      const tokens = tokenize(query.term);
      if (!normalized || tokens.size === 0) {
        return [];
      }

      return entries
        .filter((entry) => entry.normalized !== normalized || entry.source !== query.source)
        .map((entry): SemanticNeighbor => ({
          term: entry.term,
          source: entry.source,
          score: Math.max(
            0,
            Math.min(1, scoreTokenOverlap(tokens, entry.tokens) + sourceCompatibilityBoost(query.source, entry.source))
          ),
          reviewUnitCount: entry.reviewUnitCount,
          descriptorCount: entry.descriptorCount,
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
        .slice(0, limit);
    },
  };
}

export function buildSemanticIndex(
  reviewUnits: Array<Pick<ReviewUnitRecord, "activeVocab" | "approvedVocabUsed" | "proposedVocab">>,
  vocabulary: Iterable<VocabularyEntry>,
  stats: Map<string, VocabStats>
) {
  const indexedTerms = new Map<string, IndexedTerm>();

  const addTerm = (term: string, source: FlowTermSource) => {
    const normalized = normalizeVocabularyValue(term);
    if (!normalized) {
      return;
    }

    const key = `${source}::${normalized}`;
    if (indexedTerms.has(key)) {
      return;
    }

    indexedTerms.set(key, {
      term,
      source,
      normalized,
      tokens: tokenize(term),
      reviewUnitCount: stats.get(term)?.reviewUnitCount,
      descriptorCount: stats.get(term)?.descriptorCount,
    });
  };

  for (const unit of reviewUnits) {
    const terms = canonicalizeSemanticTerms(
      unit.activeVocab?.length ? unit.activeVocab : [...(unit.approvedVocabUsed ?? []), ...(unit.proposedVocab ?? [])],
      vocabulary
    );
    for (const term of terms) {
      addTerm(term, "historical");
    }
  }

  for (const entry of vocabulary) {
    addTerm(entry.term, "registry");
    for (const alias of entry.aliases ?? []) {
      addTerm(alias, "registry");
    }
  }

  return createInMemorySemanticIndex([...indexedTerms.values()]);
}

export function dedupeFlowTermCandidates(candidates: FlowTermCandidate[]) {
  const byTerm = new Map<string, FlowTermCandidate>();

  for (const candidate of candidates) {
    const normalized = normalizeVocabularyValue(candidate.term);
    if (!normalized) {
      continue;
    }

    const key = `${candidate.source}::${normalized}`;
    if (!byTerm.has(key)) {
      byTerm.set(key, candidate);
    }
  }

  return [...byTerm.values()].sort((a, b) => a.term.localeCompare(b.term) || a.source.localeCompare(b.source));
}
