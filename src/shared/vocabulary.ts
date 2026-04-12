import type { VocabularyEntry } from "./types.js";

function normalizeVocabularyValue(value: string) {
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
