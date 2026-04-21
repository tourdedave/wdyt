import type { PrerequisiteAnalysis, ReviewUnitRecord, VocabStats, VocabularyEntry } from "./types.js";
import { canonicalizeSemanticTerms, normalizeVocabularyValue } from "./vocabulary.js";

export function collectVocabStats(
  reviewUnits: Array<Pick<ReviewUnitRecord, "activeDescriptor" | "proposedDescriptor" | "activeVocab" | "approvedVocabUsed" | "proposedVocab">>,
  vocabulary: Iterable<VocabularyEntry>
) {
  const totalReviewUnits = Math.max(1, reviewUnits.length);
  const termToReviewUnits = new Map<string, number>();
  const termToDescriptors = new Map<string, Set<string>>();

  for (const unit of reviewUnits) {
    const descriptor = (unit.activeDescriptor ?? unit.proposedDescriptor ?? "").trim();
    const normalizedTerms = canonicalizeSemanticTerms(
      unit.activeVocab?.length ? unit.activeVocab : [...(unit.approvedVocabUsed ?? []), ...(unit.proposedVocab ?? [])],
      vocabulary
    );

    for (const term of normalizedTerms) {
      termToReviewUnits.set(term, (termToReviewUnits.get(term) ?? 0) + 1);

      const descriptors = termToDescriptors.get(term) ?? new Set<string>();
      if (descriptor) {
        descriptors.add(descriptor);
      }
      termToDescriptors.set(term, descriptors);
    }
  }

  const statsEntries: Array<[string, VocabStats]> = [...termToReviewUnits.entries()]
    .map(([term, reviewUnitCount]): [string, VocabStats] => [
      term,
      {
        term,
        reviewUnitCount,
        descriptorCount: termToDescriptors.get(term)?.size ?? 0,
        idf: Math.log(totalReviewUnits / reviewUnitCount),
      },
    ])
    .sort((a, b) => a[0].localeCompare(b[0]));

  return new Map<string, VocabStats>(statsEntries);
}

export function analyzePrerequisites(
  flowTerms: string[],
  globalStats: Map<string, VocabStats>,
  config: {
    maxIdf: number;
    minDistinctDescriptorCount: number;
  } = {
    maxIdf: 0.9,
    minDistinctDescriptorCount: 3,
  }
): PrerequisiteAnalysis {
  const normalizedTerms = [...new Set(flowTerms.map((term) => term.trim()).filter(Boolean))];

  if (normalizedTerms.length <= 1) {
    return {
      prerequisiteTerms: [],
      primaryTerms: normalizedTerms,
    };
  }

  const prerequisiteTerms = normalizedTerms.filter((term) => {
    const stats = globalStats.get(term);
    if (!stats) {
      return false;
    }

    return stats.idf <= config.maxIdf && stats.descriptorCount >= config.minDistinctDescriptorCount;
  });

  let primaryTerms = normalizedTerms.filter((term) => !prerequisiteTerms.includes(term));

  if (primaryTerms.length === 0) {
    const ranked = normalizedTerms
      .map((term) => ({
        term,
        stats: globalStats.get(term),
      }))
      .sort(
        (a, b) =>
          (b.stats?.idf ?? Number.POSITIVE_INFINITY) - (a.stats?.idf ?? Number.POSITIVE_INFINITY) ||
          (a.stats?.descriptorCount ?? 0) - (b.stats?.descriptorCount ?? 0) ||
          a.term.localeCompare(b.term)
      );
    const keeper = ranked[0]?.term;
    primaryTerms = keeper ? [keeper] : normalizedTerms.slice(0, 1);
  }

  return {
    prerequisiteTerms: normalizedTerms.filter((term) => !primaryTerms.includes(term)),
    primaryTerms,
  };
}

export function inferEvidenceTerms(
  evidenceValues: string[],
  globalStats: Map<string, VocabStats>,
  vocabulary: Iterable<VocabularyEntry>,
  seededTerms: string[] = []
) {
  const normalizedEvidence = evidenceValues.map((value) => normalizeVocabularyValue(value)).filter(Boolean);
  const matchedTerms = new Set(canonicalizeSemanticTerms(seededTerms, vocabulary));

  for (const term of globalStats.keys()) {
    const normalizedTerm = normalizeVocabularyValue(term);
    if (!normalizedTerm || normalizedTerm.length < 3) {
      continue;
    }

    if (normalizedEvidence.some((value) => value.includes(normalizedTerm))) {
      matchedTerms.add(term);
    }
  }

  return [...matchedTerms].sort((a, b) => a.localeCompare(b));
}
