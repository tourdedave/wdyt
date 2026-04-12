import type { FlowDescriptorProposal, VocabularyEntry } from "./types.js";
import { resolveApprovedVocabularyTerm } from "./vocabulary.js";

const LOW_LEVEL_TERMS = new Set(["navigate", "input", "change", "click", "submit"]);

type ProposalEvidence = {
  canonical: string[];
  urls: string[];
  finalUrls: string[];
  titles: string[];
  headings: string[];
  alerts: string[];
  targets: string[];
};

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

function extractTypedValues(targets: string[]) {
  const values = new Set<string>();

  for (const target of targets) {
    if (!/^input\(|^textarea\(/.test(target)) {
      continue;
    }

    const matches = target.matchAll(/"([^"]+)"/g);
    for (const match of matches) {
      const value = match[1]?.trim();
      if (value) {
        values.add(value);
      }
    }
  }

  return [...values];
}

function hasLowLevelNarration(descriptor: string) {
  const normalized = normalizeText(descriptor);
  return [...LOW_LEVEL_TERMS].some((term) => normalized.includes(term));
}

function includesAnySubstring(haystack: string, needles: string[]) {
  const normalizedHaystack = normalizeText(haystack);
  return needles.some((needle) => {
    const normalizedNeedle = normalizeText(needle);
    return normalizedNeedle.length >= 3 && normalizedHaystack.includes(normalizedNeedle);
  });
}

function normalizeProposedTermIssues(proposedVocab: string[], evidence: ProposalEvidence, vocabulary: Iterable<VocabularyEntry>) {
  const issues: string[] = [];
  const typedValues = extractTypedValues(evidence.targets);
  const urls = [...evidence.urls, ...evidence.finalUrls];

  if (proposedVocab.some((term) => LOW_LEVEL_TERMS.has(normalizeText(term)))) {
    issues.push("Proposed vocabulary includes low-level event mechanics instead of semantic concepts.");
  }

  if (proposedVocab.some((term) => includesAnySubstring(term, typedValues))) {
    issues.push("Proposed vocabulary includes literal typed values from the evidence.");
  }

  if (proposedVocab.some((term) => includesAnySubstring(term, urls))) {
    issues.push("Proposed vocabulary includes raw URLs from the evidence.");
  }

  if (
    proposedVocab.some((term) => {
      const canonical = resolveApprovedVocabularyTerm(term, vocabulary);
      return canonical != null && canonical !== term;
    })
  ) {
    issues.push("Proposed vocabulary uses aliases or non-canonical approved terms instead of canonical registry terms.");
  }

  return issues;
}

export function validateProposal(
  evidence: ProposalEvidence,
  proposal: FlowDescriptorProposal,
  vocabulary: Iterable<VocabularyEntry>
) {
  const issues: string[] = [];
  const typedValues = extractTypedValues(evidence.targets);
  const urls = [...evidence.urls, ...evidence.finalUrls];

  if (includesAnySubstring(proposal.descriptor, typedValues)) {
    issues.push("The descriptor includes a literal typed value from the evidence that should be generalized.");
  }

  if (includesAnySubstring(proposal.descriptor, urls)) {
    issues.push("The descriptor includes a raw URL from the evidence instead of a semantic label.");
  }

  if (hasLowLevelNarration(proposal.descriptor)) {
    issues.push("The descriptor narrates low-level UI mechanics or reduced event steps instead of the semantic task or outcome.");
  }

  if (proposal.approvedVocab.length === 0 && proposal.proposedVocab.length === 0) {
    issues.push("The proposal does not include any approved or proposed semantic vocabulary.");
  }

  issues.push(...normalizeProposedTermIssues(proposal.proposedVocab, evidence, vocabulary));

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function adjustProposalConfidence(baseConfidence: number, issues: string[]) {
  let adjusted = baseConfidence;

  for (const issue of issues) {
    if (issue.includes("literal typed value")) {
      adjusted -= 0.4;
      continue;
    }

    if (issue.includes("low-level UI mechanics")) {
      adjusted -= 0.25;
      continue;
    }

    if (issue.includes("does not include any approved or proposed semantic vocabulary")) {
      adjusted -= 0.2;
      continue;
    }

    if (issue.includes("raw URL")) {
      adjusted -= 0.2;
      continue;
    }

    adjusted -= 0.15;
  }

  return Math.max(0.05, Math.min(1, adjusted));
}
