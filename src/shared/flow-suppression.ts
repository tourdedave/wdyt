import type { FlowTermCandidate, PrerequisiteAnalysis, ReviewUnitRecord, SemanticIndex, VocabStats, VocabularyEntry } from "./types.js";
import { canonicalizeConceptTerm, canonicalizeSemanticTerms, normalizeVocabularyValue } from "./vocabulary.js";

function isGenericPrimaryTerm(term: string) {
  const normalized = normalizeVocabularyValue(term);
  if (!normalized) {
    return true;
  }

  return (
    normalized === "success" ||
    normalized === "redirect" ||
    normalized === "navigation" ||
    normalized === "authentication flow" ||
    normalized === "flow"
  );
}

function isGenericSemanticTerm(term: string) {
  const normalized = normalizeVocabularyValue(term);
  return (
    normalized === "success" ||
    normalized === "successful" ||
    normalized === "redirect" ||
    normalized === "navigation" ||
    normalized === "flow" ||
    normalized === "access"
  );
}

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
  const specificPrimaryTerms = primaryTerms.filter((term) => !isGenericPrimaryTerm(term));

  if (specificPrimaryTerms.length > 0) {
    primaryTerms = specificPrimaryTerms;
  }

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
    const keeper = ranked.find((entry) => !isGenericPrimaryTerm(entry.term))?.term ?? ranked[0]?.term;
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
    if (!normalizedTerm || normalizedTerm.length < 3 || isGenericSemanticTerm(normalizedTerm)) {
      continue;
    }

    if (normalizedEvidence.some((value) => value.includes(normalizedTerm))) {
      matchedTerms.add(term);
    }
  }

  return [...matchedTerms].sort((a, b) => a.localeCompare(b));
}

function extractSemanticPhrasesFromValue(value: string) {
  const phrases = new Set<string>();

  const rawValue = value.trim();
  if (/^input\(/i.test(rawValue)) {
    return [];
  }

  try {
    const parsed = new URL(value);
    const segments = parsed.pathname
      .split("/")
      .map((segment) => normalizeVocabularyValue(decodeURIComponent(segment)))
      .filter(Boolean);

    for (const segment of segments) {
      phrases.add(segment);
    }

    if (segments.length >= 2) {
      phrases.add(segments.slice(-2).join(" "));
    }

    return [...phrases];
  } catch {
    // Not a URL, fall through to text handling.
  }

  const normalized = normalizeVocabularyValue(
    value
      .replace(/\b(button|form|input|textarea|link)\b/g, " ")
      .replace(/[()"]/g, " ")
  );
  if (!normalized) {
    return [];
  }

  if (/^[a-z0-9]{1,3}$/.test(normalized)) {
    return [];
  }

  if (/^[a-z]+(?:\s[a-z]+)*\s\d{1,4}(?:\s\d{1,4})*$/.test(normalized)) {
    return [];
  }

  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length > 0 && tokens.length <= 4) {
    const concept = canonicalizeConceptTerm(tokens.join(" "), []);
    if (concept) {
      phrases.add(concept);
    }
  }
  if (tokens.length >= 2) {
    const concept = canonicalizeConceptTerm(tokens.slice(-2).join(" "), []);
    if (concept) {
      phrases.add(concept);
    }
  }

  return [...phrases];
}

export function inferSourceAwareTermCandidates(
  evidence: {
    setupValues: string[];
    actionValues: string[];
    endStateValues: string[];
    registryTerms?: string[];
  },
  globalStats: Map<string, VocabStats>,
  vocabulary: Iterable<VocabularyEntry>
) {
  const candidates: FlowTermCandidate[] = [];

  const addBucketTerms = (terms: string[], source: FlowTermCandidate["source"]) => {
    for (const term of canonicalizeSemanticTerms(terms, vocabulary)) {
      candidates.push({ term, source });
    }
  };

  const addExtractedBucketTerms = (values: string[], source: FlowTermCandidate["source"]) => {
    const extractedTerms = values.flatMap((value) => extractSemanticPhrasesFromValue(value));
    addBucketTerms(extractedTerms, source);
  };

  addBucketTerms(
    inferEvidenceTerms(evidence.setupValues, globalStats, vocabulary, [...(evidence.registryTerms ?? [])]),
    "setup"
  );
  addExtractedBucketTerms(evidence.setupValues, "setup");
  addBucketTerms(
    inferEvidenceTerms(evidence.actionValues, globalStats, vocabulary, [...(evidence.registryTerms ?? [])]),
    "action"
  );
  addExtractedBucketTerms(evidence.actionValues, "action");
  addBucketTerms(
    inferEvidenceTerms(evidence.endStateValues, globalStats, vocabulary, [...(evidence.registryTerms ?? [])]),
    "end-state"
  );
  addExtractedBucketTerms(evidence.endStateValues, "end-state");
  addBucketTerms(evidence.registryTerms ?? [], "registry");

  return candidates;
}

export function scoreFlowTermRoles(
  candidates: FlowTermCandidate[],
  globalStats: Map<string, VocabStats>,
  semanticIndex: SemanticIndex
): PrerequisiteAnalysis {
  const grouped = new Map<string, Set<FlowTermCandidate["source"]>>();
  for (const candidate of candidates) {
    const current = grouped.get(candidate.term) ?? new Set<FlowTermCandidate["source"]>();
    current.add(candidate.source);
    grouped.set(candidate.term, current);
  }

  const terms = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  if (terms.length <= 1) {
    return {
      prerequisiteTerms: [],
      primaryTerms: terms,
    };
  }

  const hasAction = terms.some((term) => grouped.get(term)?.has("action"));
  const hasEndState = terms.some((term) => grouped.get(term)?.has("end-state"));
  const endStateOnlyTerms = terms.filter((term) => {
    const sources = grouped.get(term) ?? new Set<FlowTermCandidate["source"]>();
    return sources.has("end-state") && !sources.has("setup");
  });
  const actionOnlyTerms = terms.filter((term) => {
    const sources = grouped.get(term) ?? new Set<FlowTermCandidate["source"]>();
    return sources.has("action") && !sources.has("setup");
  });
  const setupEndStateTerms = terms.filter((term) => {
    const sources = grouped.get(term) ?? new Set<FlowTermCandidate["source"]>();
    return sources.has("setup") && sources.has("end-state");
  });
  const fullLifecycleTerms = terms.filter((term) => {
    const sources = grouped.get(term) ?? new Set<FlowTermCandidate["source"]>();
    return sources.has("setup") && sources.has("action") && sources.has("end-state");
  });
  const tokenizedTerms = new Map(terms.map((term) => [term, new Set(normalizeVocabularyValue(term).split(" ").filter(Boolean))]));

  const scored = terms.map((term) => {
    const sources = grouped.get(term) ?? new Set<FlowTermCandidate["source"]>();
    const stats = globalStats.get(term);
    const tokens = tokenizedTerms.get(term) ?? new Set<string>();
    let primaryScore = 0;
    let prerequisiteScore = 0;
    let outcomeScore = 0;

    if (sources.has("setup")) {
      prerequisiteScore += 3;
      primaryScore += 0.1;
    }
    if (sources.has("action")) {
      primaryScore += 3;
      prerequisiteScore += 0.2;
    }
    if (sources.has("end-state")) {
      primaryScore += 2.5;
      outcomeScore += 3.5;
      prerequisiteScore -= 0.5;
    }
    if (sources.has("registry")) {
      primaryScore += 0.8;
      outcomeScore += 0.4;
    }

    if (stats) {
      const distinctiveness = Math.max(0, Math.min(2.5, stats.idf));
      const commonness = Math.max(0, 1 - Math.min(2.5, stats.idf) / 2.5);
      primaryScore += distinctiveness;
      outcomeScore += distinctiveness * 0.8;
      prerequisiteScore += commonness * (sources.has("setup") ? 1.5 : 0.5);
    }

    if ((hasAction || hasEndState) && sources.has("setup") && !sources.has("action") && !sources.has("end-state")) {
      primaryScore -= 2.5;
    }

    if (hasEndState && !sources.has("end-state") && (sources.has("setup") || sources.has("action"))) {
      primaryScore -= 1.35;
    }

    if (sources.has("end-state") && !sources.has("setup")) {
      primaryScore += 1.2;
      outcomeScore += 0.8;
    }

    const neighbors = semanticIndex.search({ term }, 5);
    for (const neighbor of neighbors) {
      if (neighbor.source === "end-state") {
        outcomeScore += neighbor.score * 0.8;
        primaryScore += neighbor.score * 0.35;
      } else if (neighbor.source === "action") {
        primaryScore += neighbor.score * 0.8;
      } else if (neighbor.source === "setup") {
        prerequisiteScore += neighbor.score * 0.8;
      }
    }

    if (endStateOnlyTerms.length > 0 && !sources.has("end-state") && !sources.has("registry")) {
      prerequisiteScore += 0.35;
    }

    const longerRelatedTerms = terms.filter((candidate) => {
      if (candidate === term) {
        return false;
      }
      const candidateTokens = tokenizedTerms.get(candidate) ?? new Set<string>();
      if (candidateTokens.size <= tokens.size || tokens.size === 0) {
        return false;
      }
      for (const token of tokens) {
        if (!candidateTokens.has(token)) {
          return false;
        }
      }
      return true;
    });

    if (longerRelatedTerms.length > 0) {
      primaryScore -= 0.85;
      outcomeScore -= 0.25;

      const longerEndStateTerms = longerRelatedTerms.filter((candidate) => grouped.get(candidate)?.has("end-state"));
      if (tokens.size === 1 && longerEndStateTerms.length > 0) {
        primaryScore -= 1.2;
      }
    }

    if (tokens.size > 1 && (sources.has("action") || sources.has("end-state"))) {
      primaryScore += 0.45;
      outcomeScore += sources.has("end-state") ? 0.3 : 0;
    }

    if (actionOnlyTerms.length > 0 && sources.has("action") && !sources.has("end-state")) {
      primaryScore += 0.5;
    }

    if (setupEndStateTerms.length > 0 && sources.has("action") && !sources.has("setup") && !sources.has("end-state")) {
      primaryScore += 1.4;
      prerequisiteScore -= 0.4;
    }

    if (actionOnlyTerms.length > 0 && sources.has("setup") && sources.has("end-state") && !sources.has("action")) {
      primaryScore -= 0.9;
    }

    if (fullLifecycleTerms.length > 0 && sources.has("action") && !sources.has("setup") && !sources.has("end-state")) {
      primaryScore += 1.1;
      prerequisiteScore -= 0.2;
    }

    if (actionOnlyTerms.length > 0 && sources.has("setup") && sources.has("action") && sources.has("end-state")) {
      primaryScore -= 1.4;
      prerequisiteScore += 0.35;
    }

    return { term, sources, primaryScore, prerequisiteScore, outcomeScore };
  });

  const maxPrimary = Math.max(...scored.map((entry) => entry.primaryScore));
  const maxOutcome = Math.max(...scored.map((entry) => entry.outcomeScore));
  let primaryTerms = scored
    .filter((entry) => entry.primaryScore >= entry.prerequisiteScore && entry.primaryScore >= maxPrimary - 0.75)
    .map((entry) => entry.term);

  primaryTerms = primaryTerms.filter((term) => {
    const tokens = tokenizedTerms.get(term) ?? new Set<string>();
    return !primaryTerms.some((candidate) => {
      if (candidate === term) {
        return false;
      }
      const candidateTokens = tokenizedTerms.get(candidate) ?? new Set<string>();
      if (candidateTokens.size <= tokens.size || tokens.size === 0) {
        return false;
      }
      for (const token of tokens) {
        if (!candidateTokens.has(token)) {
          return false;
        }
      }
      return true;
    });
  });

  const outcomeTerms = scored
    .filter(
      (entry) =>
        entry.sources.has("end-state") &&
        // end-state evidence should generally dominate explicit result terms
        entry.outcomeScore >= entry.primaryScore + 0.35 &&
        entry.outcomeScore >= maxOutcome - 0.6
    )
    .map((entry) => entry.term)
    .filter((term) => !primaryTerms.includes(term));

  const prerequisiteTerms = scored
    .filter(
      (entry) =>
        !primaryTerms.includes(entry.term) &&
        !outcomeTerms.includes(entry.term) &&
        entry.prerequisiteScore > entry.primaryScore + 0.2
    )
    .map((entry) => entry.term);

  if (primaryTerms.length === 0) {
    const fallback = scored
      .slice()
      .sort((a, b) => b.primaryScore - a.primaryScore || a.term.localeCompare(b.term))[0]?.term;
    return {
      prerequisiteTerms: terms.filter((term) => term !== fallback),
      primaryTerms: fallback ? [fallback] : terms.slice(0, 1),
    };
  }

  return {
    prerequisiteTerms: prerequisiteTerms.sort((a, b) => a.localeCompare(b)),
    primaryTerms: primaryTerms.sort((a, b) => a.localeCompare(b)),
  };
}
