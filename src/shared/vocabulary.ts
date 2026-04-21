import type { VocabularyEntry } from "./types.js";

export function normalizeVocabularyValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCandidateTerms(entry: VocabularyEntry) {
  return [entry.term, ...(entry.aliases ?? [])]
    .map((value) => value.trim())
    .filter(Boolean);
}

export function getApprovedVocabulary(entries: Iterable<VocabularyEntry>) {
  return [...entries].filter((entry) => entry.status === "approved");
}

export function resolveApprovedVocabularyTerm(term: string, entries: Iterable<VocabularyEntry>) {
  const normalizedTerm = normalizeVocabularyValue(term);
  if (!normalizedTerm) {
    return null;
  }

  for (const entry of getApprovedVocabulary(entries)) {
    for (const candidate of buildCandidateTerms(entry)) {
      if (normalizeVocabularyValue(candidate) === normalizedTerm) {
        return entry.term;
      }
    }
  }

  return null;
}

export function findApprovedVocabularyMatches(evidenceValues: string[], entries: Iterable<VocabularyEntry>) {
  const approved = getApprovedVocabulary(entries);
  const rawEvidence = evidenceValues.map((value) => value.trim().toLowerCase()).filter(Boolean);
  const normalizedEvidence = rawEvidence.map((value) => normalizeVocabularyValue(value)).filter(Boolean);
  const matches = new Set<string>();

  for (const entry of approved) {
    for (const candidate of buildCandidateTerms(entry)) {
      const rawCandidate = candidate.trim().toLowerCase();
      const normalizedCandidate = normalizeVocabularyValue(candidate);
      if (!rawCandidate || !normalizedCandidate) {
        continue;
      }

      const matched =
        rawEvidence.some((value) => value.includes(rawCandidate)) ||
        normalizedEvidence.some((value) => value.includes(normalizedCandidate));

      if (matched) {
        matches.add(entry.term);
        break;
      }
    }
  }

  return [...matches].sort((a, b) => a.localeCompare(b));
}

export function normalizeProposedVocabulary(terms: string[], entries: Iterable<VocabularyEntry>) {
  const proposedTerms = new Set<string>();
  const approvedTerms = new Set<string>();

  for (const term of terms) {
    const normalizedTerm = term.trim();
    if (!normalizedTerm) {
      continue;
    }

    const approvedTerm = resolveApprovedVocabularyTerm(normalizedTerm, entries);
    if (approvedTerm) {
      approvedTerms.add(approvedTerm);
      continue;
    }

    proposedTerms.add(normalizedTerm);
  }

  return {
    approvedVocab: [...approvedTerms].sort((a, b) => a.localeCompare(b)),
    proposedVocab: [...proposedTerms].sort((a, b) => a.localeCompare(b)),
  };
}

export function canonicalizeSemanticTerms(terms: string[], entries: Iterable<VocabularyEntry>) {
  const normalized = normalizeProposedVocabulary(terms, entries);
  const canonicalTerms = [...new Set([...normalized.approvedVocab, ...normalized.proposedVocab])];
  const normalizedTerms = new Set(canonicalTerms.map((term) => normalizeVocabularyValue(term)).filter(Boolean));

  // Contextual fold: a critical flow like "search and display results" should land in the
  // same vocabulary space as reviewed flows that use the compound term "search results".
  if (normalizedTerms.has("search") && normalizedTerms.has("results") && !normalizedTerms.has("search results")) {
    const searchResultsTerm = resolveApprovedVocabularyTerm("search results", entries) ?? "search results";
    return canonicalTerms
      .filter((term) => normalizeVocabularyValue(term) !== "results")
      .concat(searchResultsTerm)
      .filter(Boolean)
      .filter((term, index, values) => values.findIndex((candidate) => candidate.localeCompare(term) === 0) === index)
      .sort((a, b) => a.localeCompare(b));
  }

  return canonicalTerms.sort((a, b) => a.localeCompare(b));
}

function foldOverlapTerm(term: string) {
  const normalized = normalizeVocabularyValue(term);
  if (!normalized) {
    return null;
  }

  if (normalized === "success") {
    return null;
  }

  if (normalized.includes("dashboard")) {
    return "dashboard";
  }

  if (normalized.includes("search results")) {
    return "search results";
  }

  if (normalized === "search" || (normalized.includes("search") && normalized.includes("query"))) {
    return "search";
  }

  if (normalized.includes("login")) {
    return "login";
  }

  if (normalized.includes("authentication") && (normalized.includes("success") || normalized.includes("successful"))) {
    return "login";
  }

  return normalized;
}

export function normalizeOverlapTerms(terms: string[], entries: Iterable<VocabularyEntry>) {
  const canonicalTerms = canonicalizeSemanticTerms(terms, entries);
  const foldedTerms = canonicalTerms.map((term) => foldOverlapTerm(term)).filter((term): term is string => Boolean(term));
  return [...new Set(foldedTerms)].sort((a, b) => a.localeCompare(b));
}
