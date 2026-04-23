import type { FlowTermCandidate, FlowTermSource, ResolvedFlowConcept, SemanticIndex, VocabularyEntry } from "./types.js";
import { canonicalizeConceptTerm, normalizeVocabularyValue } from "./vocabulary.js";

type ConceptResolverInput = {
  candidates: FlowTermCandidate[];
  semanticIndex: SemanticIndex;
  vocabulary: Iterable<VocabularyEntry>;
};

function scoreSourceStability(sources: Set<FlowTermSource>) {
  let score = 0;
  if (sources.has("action")) {
    score += 0.35;
  }
  if (sources.has("end-state")) {
    score += 0.35;
  }
  if (sources.has("registry")) {
    score += 0.1;
  }
  if (sources.has("setup")) {
    score += 0.05;
  }
  return Math.min(0.85, score);
}

function dedupeNeighbors(term: string, semanticIndex: SemanticIndex, sources: Set<FlowTermSource>) {
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

function resolveTermLabel(
  term: string,
  vocabulary: Iterable<VocabularyEntry>,
  neighbors: ReturnType<typeof dedupeNeighbors>
) {
  const builtin = canonicalizeConceptTerm(term, vocabulary);
  if (builtin) {
    return { term: builtin, strategy: "builtin" as const, confidence: 0.92 };
  }

  const neighbor = neighbors.find((candidate) => candidate.score >= 0.92);
  if (neighbor) {
    return {
      term: neighbor.term,
      strategy: "semantic-neighbor" as const,
      confidence: Math.max(0.75, Math.min(0.91, neighbor.score)),
    };
  }

  const normalized = normalizeVocabularyValue(term);
  if (!normalized) {
    return null;
  }

  return {
    term: normalized,
    strategy: "literal" as const,
    confidence: 0.55,
  };
}

export function resolveFlowConcepts(input: ConceptResolverInput): ResolvedFlowConcept[] {
  const grouped = new Map<string, { rawTerms: Set<string>; sources: Set<FlowTermSource>; neighbors: ReturnType<typeof dedupeNeighbors> }>();

  for (const candidate of input.candidates) {
    const neighbors = dedupeNeighbors(candidate.term, input.semanticIndex, new Set([candidate.source]));
    const resolved = resolveTermLabel(candidate.term, input.vocabulary, neighbors);
    if (!resolved) {
      continue;
    }

    const current = grouped.get(resolved.term) ?? {
      rawTerms: new Set<string>(),
      sources: new Set<FlowTermSource>(),
      neighbors: [],
    };
    current.rawTerms.add(candidate.term);
    current.sources.add(candidate.source);
    current.neighbors = [...current.neighbors, ...neighbors]
      .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
      .filter((neighbor, index, values) => values.findIndex((entry) => entry.term === neighbor.term) === index)
      .slice(0, 5);
    grouped.set(resolved.term, current);
  }

  return [...grouped.entries()]
    .map(([term, value]) => ({
      term,
      rawTerms: [...value.rawTerms].sort((a, b) => a.localeCompare(b)),
      sources: [...value.sources].sort((a, b) => a.localeCompare(b)) as FlowTermSource[],
      confidence: Math.min(0.98, scoreSourceStability(value.sources) + (value.neighbors[0]?.score ?? 0) * 0.1 + 0.1),
      strategy: (
        value.rawTerms.has(term)
          ? "literal"
          : value.neighbors.some((neighbor) => neighbor.term === term)
            ? "semantic-neighbor"
            : "builtin"
      ) as "builtin" | "semantic-neighbor" | "literal",
      neighbors: value.neighbors,
    }))
    .sort((a, b) => a.term.localeCompare(b.term));
}

export function resolvedConceptsToCandidates(concepts: ResolvedFlowConcept[]): FlowTermCandidate[] {
  return concepts.flatMap((concept) =>
    concept.sources.map((source) => ({
      term: concept.term,
      source,
    }))
  );
}

export function summarizeRoleEvidence(input: {
  concepts: ResolvedFlowConcept[];
  prerequisiteTerms: string[];
  primaryTerms: string[];
}) {
  const rationale: string[] = [];

  for (const concept of input.concepts) {
    if (input.primaryTerms.includes(concept.term)) {
      rationale.push(
        `${concept.term}: primary via ${concept.sources.join("+")} (${concept.strategy}, confidence ${concept.confidence.toFixed(2)})`
      );
      continue;
    }

    if (input.prerequisiteTerms.includes(concept.term)) {
      rationale.push(
        `${concept.term}: prerequisite via ${concept.sources.join("+")} (${concept.strategy}, confidence ${concept.confidence.toFixed(2)})`
      );
    }
  }

  return {
    prerequisiteTerms: [...input.prerequisiteTerms].sort((a, b) => a.localeCompare(b)),
    primaryTerms: [...input.primaryTerms].sort((a, b) => a.localeCompare(b)),
    rationale,
  };
}
