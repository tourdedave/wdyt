import type { FlowDescriptorProposal, VocabularyEntry } from "./types.js";
import { resolveApprovedVocabularyTerm } from "./vocabulary.js";

const LOW_LEVEL_TERMS = new Set(["navigate", "input", "change", "click", "submit"]);
const MECHANICAL_DESCRIPTOR_PATTERNS = [
  /\bnavigat(?:e|es|ed|ing)\b/,
  /\bnavigation\s+to\b/,
  /\bperform(?:s|ed|ing)?\b/,
  /\bexecute(?:s|d|ing)?\b/,
  /\brun(?:s|ning)?\b/,
  /\b(?:is|are)\s+displayed\b/,
  /\bdisplayed\b/,
  /\b(?:is|are)\s+performed\b/,
  /\b(?:is|are)\s+accessed\b/,
];
const UNSUPPORTED_SUCCESS_PATTERNS = [
  /\bupdated?\b/,
  /\bsaved?\b/,
  /\bsubmitted?\b/,
  /\bcompleted?\b/,
  /\bsuccessfully\b/,
];

export type ProposalEvidence = {
  canonical: string[];
  descriptorExcludedTerms?: string[];
  flowTerms?: string[];
  primaryTerms?: string[];
  outcomeTerms?: string[];
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

export function isLowValueProposalTerm(term: string) {
  const normalized = normalizeText(term);
  return LOW_LEVEL_TERMS.has(normalized)
    || /\b(?:navigation|navigate|execute|run)\b/.test(normalized)
    || MECHANICAL_DESCRIPTOR_PATTERNS.some((pattern) => pattern.test(normalized))
    || UNSUPPORTED_SUCCESS_PATTERNS.some((pattern) => pattern.test(normalized));
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
  return [...LOW_LEVEL_TERMS].some((term) => normalized.includes(term))
    || MECHANICAL_DESCRIPTOR_PATTERNS.some((pattern) => pattern.test(normalized));
}

function hasUnsupportedSuccessClaim(descriptor: string, evidence: ProposalEvidence) {
  const normalized = normalizeText(descriptor);
  if (!UNSUPPORTED_SUCCESS_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const successEvidence = [
    ...evidence.titles,
    ...evidence.headings,
    ...evidence.alerts,
    ...evidence.finalUrls,
  ].map((value) => normalizeText(value));

  return !successEvidence.some((value) => /\b(?:success|successful|updated|saved|completed|done)\b/.test(value));
}

function clampConfidence(value: number) {
  if (Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0.05, Math.min(1, value));
}

function includesSequence(canonical: string[], sequence: string[]) {
  let index = 0;

  for (const step of canonical) {
    if (step === sequence[index]) {
      index += 1;
      if (index === sequence.length) {
        return true;
      }
    }
  }

  return false;
}

function extractPathSegments(urls: string[]) {
  const segments = new Set<string>();

  for (const value of urls) {
    try {
      const pathname = new URL(value).pathname;
      for (const segment of pathname.split("/")) {
        const trimmed = segment.trim().toLowerCase();
        if (trimmed) {
          segments.add(trimmed);
        }
      }
    } catch {
      // Ignore malformed URLs in evidence.
    }
  }

  return [...segments];
}

function hasAnyKeyword(values: string[], keywords: string[]) {
  return values.some((value) => {
    const normalizedValue = normalizeText(value);
    return keywords.some((keyword) => normalizedValue.includes(keyword));
  });
}

function inferDeterministicConfidence(evidence: ProposalEvidence) {
  const finalPathSegments = extractPathSegments(evidence.finalUrls);
  const finalLabels = [...evidence.titles, ...evidence.headings, ...finalPathSegments];
  const targetLabels = evidence.targets.map((target) => normalizeText(target));
  const hasSubmit = evidence.canonical.includes("SUBMIT");
  const hasPostSubmitNavigation = includesSequence(evidence.canonical, ["SUBMIT", "NAVIGATE"]);
  const hasNavigation = evidence.canonical.includes("NAVIGATE");
  const hasAlert = evidence.alerts.length > 0;
  const returnsToLogin = hasAnyKeyword(finalLabels, ["login", "sign in"]);
  const signsOut = targetLabels.some(
    (target) => target.includes("sign out") || target.includes("logout") || target.includes("log out")
  );
  const hasCaptchaTerminal = finalPathSegments.includes("sorry");
  const hasTerminalIdentity = finalLabels.length > 0;
  const hasNamedDestination = hasAnyKeyword(finalPathSegments, [
    "dashboard",
    "settings",
    "reports",
    "workspace",
    "search",
  ]);

  if (signsOut && returnsToLogin && hasNavigation) {
    return 0.78;
  }

  if (hasAlert || hasCaptchaTerminal) {
    return 0.82;
  }

  if (hasSubmit && hasPostSubmitNavigation && hasTerminalIdentity && !returnsToLogin) {
    return hasNamedDestination ? 0.7 : 0.66;
  }

  if (hasNavigation && hasTerminalIdentity) {
    return hasNamedDestination ? 0.62 : 0.55;
  }

  if (hasSubmit) {
    return 0.45;
  }

  return 0.3;
}

function applyValidationCaps(confidence: number, issues: string[]) {
  let capped = confidence;

  for (const issue of issues) {
    if (issue.includes("literal typed value")) {
      capped = Math.min(capped, 0.2);
      continue;
    }

    if (issue.includes("raw URL")) {
      capped = Math.min(capped, 0.35);
      continue;
    }
  }

  return capped;
}

function includesAnySubstring(haystack: string, needles: string[]) {
  const normalizedHaystack = normalizeText(haystack);
  return needles.some((needle) => {
    const normalizedNeedle = normalizeText(needle);
    return normalizedNeedle.length >= 3 && normalizedHaystack.includes(normalizedNeedle);
  });
}

export function includesDescriptorExcludedTerm(value: string, excludedTerms: string[] | undefined) {
  return includesAnySubstring(value, normalizeExcludedTerms(excludedTerms));
}

function normalizeExcludedTerms(value: string[] | undefined) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((term) => normalizeText(term))
    .filter((term) => term.length >= 3);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanupDescriptorText(value: string) {
  return value
    .replace(/\b(?:after|post|following)\s*$/i, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[,.;:!?-]+|[,.;:!?-]+$/g, "")
    .trim();
}

export function sanitizeDescriptorExcludedTerms(descriptor: string, excludedTerms: string[] | undefined) {
  const normalizedExcludedTerms = normalizeExcludedTerms(excludedTerms).sort((a, b) => b.length - a.length);
  if (normalizedExcludedTerms.length === 0) {
    return descriptor;
  }

  let sanitized = descriptor;
  for (const term of normalizedExcludedTerms) {
    sanitized = sanitized.replace(new RegExp(`\\b${escapeRegex(term)}\\b`, "gi"), " ");
  }

  sanitized = cleanupDescriptorText(sanitized);
  return sanitized || descriptor;
}

function titleCaseTerm(term: string) {
  return term.replace(/\b\w/g, (match) => match.toUpperCase());
}

function preferViewVerb(term: string) {
  return /\b(?:details|results|dashboard|screen|page)\b/.test(normalizeText(term));
}

export function buildFallbackDescriptor(evidence: ProposalEvidence) {
  const primary = evidence.primaryTerms?.[0];
  const outcome = evidence.outcomeTerms?.[0];

  if (primary === "search" && outcome === "no results") {
    return "Search returns no results";
  }

  if (primary === "search" && outcome === "search results") {
    return "View search results";
  }

  if (primary && !outcome) {
    return `${preferViewVerb(primary) ? "View" : "Access"} ${primary}`;
  }

  if (outcome && !primary) {
    return `${preferViewVerb(outcome) ? "View" : "Access"} ${outcome}`;
  }

  if (primary && outcome) {
    if (preferViewVerb(outcome)) {
      return `View ${outcome}`;
    }

    return `${titleCaseTerm(primary)} returns ${outcome}`;
  }

  const fallbackTerm = evidence.flowTerms?.[0];
  if (fallbackTerm) {
    return `${preferViewVerb(fallbackTerm) ? "View" : "Access"} ${fallbackTerm}`;
  }

  return "Review flow";
}

export function buildProposalRetryFeedback(issues: string[]) {
  const instructions = new Set<string>();

  for (const issue of issues) {
    if (issue.includes("descriptor-excluded terms")) {
      instructions.add("Do not use any descriptorExcludedTerms in the descriptor or vocabulary unless the flow is truly about them.");
    }
    if (issue.includes("low-level UI mechanics") || issue.includes("low-level event mechanics")) {
      instructions.add("Avoid navigation and UI mechanics. Prefer task-centric wording like 'Access reports' or 'View search results'.");
    }
    if (issue.includes("unsupported success")) {
      instructions.add("Do not claim success, updates, saves, or completion unless the evidence explicitly shows that outcome.");
    }
  }

  return [...instructions].join(" ");
}

function normalizeProposedTermIssues(proposedVocab: string[], evidence: ProposalEvidence, vocabulary: Iterable<VocabularyEntry>) {
  const issues: string[] = [];
  const typedValues = extractTypedValues(evidence.targets);
  const urls = [...evidence.urls, ...evidence.finalUrls];
  const excludedTerms = normalizeExcludedTerms(evidence.descriptorExcludedTerms);

  if (proposedVocab.some((term) => isLowValueProposalTerm(term))) {
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

  if (proposedVocab.some((term) => includesAnySubstring(term, excludedTerms))) {
    issues.push("Proposed vocabulary includes descriptor-excluded terms.");
  }

  if (proposedVocab.some((term) => UNSUPPORTED_SUCCESS_PATTERNS.some((pattern) => pattern.test(normalizeText(term))))) {
    issues.push("Proposed vocabulary includes unsupported success or mutation terms.");
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
  const excludedTerms = normalizeExcludedTerms(evidence.descriptorExcludedTerms);

  if (includesAnySubstring(proposal.descriptor, typedValues)) {
    issues.push("The descriptor includes a literal typed value from the evidence that should be generalized.");
  }

  if (includesAnySubstring(proposal.descriptor, urls)) {
    issues.push("The descriptor includes a raw URL from the evidence instead of a semantic label.");
  }

  if (hasLowLevelNarration(proposal.descriptor)) {
    issues.push("The descriptor narrates low-level UI mechanics or reduced event steps instead of the semantic task or outcome.");
  }

  if (hasUnsupportedSuccessClaim(proposal.descriptor, evidence)) {
    issues.push("The descriptor makes an unsupported success or mutation claim.");
  }

  if (includesAnySubstring(proposal.descriptor, excludedTerms)) {
    issues.push("The descriptor includes descriptor-excluded terms.");
  }

  if (proposal.approvedVocab.length === 0 && proposal.proposedVocab.length === 0) {
    issues.push("The proposal does not include any approved or proposed semantic vocabulary.");
  }

  if (proposal.approvedVocab.some((term) => includesAnySubstring(term, excludedTerms))) {
    issues.push("Approved vocabulary includes descriptor-excluded terms.");
  }

  issues.push(...normalizeProposedTermIssues(proposal.proposedVocab, evidence, vocabulary));

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function adjustProposalConfidence(baseConfidence: number, issues: string[]) {
  return clampConfidence(applyValidationCaps(baseConfidence, issues));
}

export function scoreProposalConfidence(
  evidence: ProposalEvidence,
  proposal: FlowDescriptorProposal,
  issues: string[]
) {
  const baseConfidence = typeof proposal.confidence === "number" ? proposal.confidence : Number(proposal.confidence);
  const deterministicConfidence = inferDeterministicConfidence(evidence);
  const blendedConfidence = Math.max(baseConfidence, deterministicConfidence);
  return clampConfidence(applyValidationCaps(blendedConfidence, issues));
}
