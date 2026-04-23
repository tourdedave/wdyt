import type { FlowTermRoleClassification, ResolvedFlowConcept } from "./types.js";

type SubflowFamily = {
  id: string;
  canonicalTerms: string[];
  descriptorExcludedAliases: Record<string, string[]>;
};

const BUILT_IN_SUBFLOW_FAMILIES = [
  {
    id: "auth",
    canonicalTerms: ["login", "logout", "authentication"],
    descriptorExcludedAliases: {
      login: [
        "login",
        "log in",
        "logged in",
        "sign in",
        "signed in",
        "authentication",
        "authenticated",
        "after login",
        "after log in",
        "after signing in",
        "after sign in",
        "after authentication",
        "after being authenticated",
        "post-login",
        "post login",
        "post-authentication",
        "post authentication",
      ],
      logout: [
        "logout",
        "log out",
        "logged out",
        "sign out",
        "signed out",
        "after logout",
        "after sign out",
        "post-logout",
        "post logout",
      ],
      authentication: [
        "authentication",
        "authenticated",
        "after authentication",
        "post-authentication",
        "post authentication",
      ],
    },
  },
] satisfies SubflowFamily[];
const OPERATIONAL_PRIMITIVE_PATTERNS = [
  /\b(?:button|click|form|submission|submit|field)\b/,
  /\b(?:input|entry|text entry)\b/,
  /\b(?:navigate|navigation)\b/,
  /\b(?:execute|run)\b/,
  /^(?:enter|initiate|submit)\s+/,
  /^(?:execute|run)\s+/,
  /^(?:open|back to)\s+/,
  /\bcredential(?:s)?\b/,
  /\blink\b/,
];

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function getSubflowFamiliesForTerm(term: string) {
  const normalizedTerm = normalize(term);
  return BUILT_IN_SUBFLOW_FAMILIES.filter((family) => family.canonicalTerms.includes(normalizedTerm));
}

export function isSubflowTerm(term: string) {
  return getSubflowFamiliesForTerm(term).length > 0;
}

export function isAuthTerm(term: string) {
  return getSubflowFamiliesForTerm(term).some((family) => family.id === "auth");
}

export function shouldSuppressSubflowTermsInDescriptor(classification: FlowTermRoleClassification) {
  return classification.primaryTerms.some((term) => !isSubflowTerm(term));
}

export function shouldSuppressAuthInDescriptor(classification: FlowTermRoleClassification) {
  return shouldSuppressSubflowTermsInDescriptor(classification);
}

export function filterAuthTermsForDescriptor(terms: string[], classification: FlowTermRoleClassification) {
  if (!shouldSuppressSubflowTermsInDescriptor(classification)) {
    return [...terms];
  }

  return terms.filter((term) => !isSubflowTerm(term));
}

export function getDescriptorExcludedTerms(terms: string[], classification: FlowTermRoleClassification) {
  if (!shouldSuppressSubflowTermsInDescriptor(classification)) {
    return [];
  }

  const excluded = new Set<string>();
  for (const term of terms) {
    for (const family of getSubflowFamiliesForTerm(term)) {
      const canonicalTerm = normalize(term);
      excluded.add(canonicalTerm);
      const aliases = family.descriptorExcludedAliases[canonicalTerm as keyof typeof family.descriptorExcludedAliases] ?? [];
      for (const alias of aliases) {
        excluded.add(alias);
      }
    }
  }

  return [...excluded].sort((a, b) => a.localeCompare(b));
}

function isOperationalTerm(term: string) {
  const normalized = normalize(term);
  return OPERATIONAL_PRIMITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function firstToken(term: string) {
  return normalize(term).split(/\s+/)[0] ?? "";
}

function scorePrerequisite(term: string, concepts: Map<string, ResolvedFlowConcept>, focusTerms: Set<string>) {
  const concept = concepts.get(term);
  if (!concept) {
    return 0;
  }

  let score = 0;
  if (isAuthTerm(term)) {
    score += 3;
  }
  if (concept.sources.includes("setup")) {
    score += 2;
  }
  if (concept.sources.includes("action") && !isOperationalTerm(term)) {
    score += 1;
  }
  if (focusTerms.has(firstToken(term))) {
    score += 1;
  }
  if (term === "dashboard") {
    score -= 2;
  }
  if (isOperationalTerm(term)) {
    score -= 3;
  }

  return score;
}

export function rebalanceClassifiedRoles(
  classification: FlowTermRoleClassification,
  concepts: ResolvedFlowConcept[]
): FlowTermRoleClassification {
  const prerequisite = new Set(classification.prerequisiteTerms);
  const primary = new Set(classification.primaryTerms);
  const outcome = new Set(classification.outcomeTerms);
  const uncertain = new Set(classification.uncertainTerms);

  const conceptByTerm = new Map(concepts.map((concept) => [concept.term, concept]));
  const focusRootTokens = new Set(
    [...primary, ...outcome]
      .map((term) => firstToken(term))
      .filter(Boolean)
  );
  const strongerNonAuthTerms = concepts
    .filter((concept) => {
      if (isAuthTerm(concept.term) || isOperationalTerm(concept.term)) {
        return false;
      }

      const hasEndState = concept.sources.includes("end-state");
      const hasAction = concept.sources.includes("action");
      return hasEndState || hasAction;
    })
    .map((concept) => concept.term);
  const authOnlyBypassTerms = new Set(["dashboard", "invalid username or password alert"]);
  const strongerTaskTerms = strongerNonAuthTerms.filter((term) => !authOnlyBypassTerms.has(term));

  const hasLogin = conceptByTerm.has("login");
  const hasLogout = conceptByTerm.has("logout");
  const hasDashboard = conceptByTerm.has("dashboard");
  const hasInvalidCredentialsAlert = conceptByTerm.has("invalid username or password alert");
  const hasNoResults = conceptByTerm.has("no results");

  const removableOperationalTerms = concepts
    .filter((concept) => isOperationalTerm(concept.term) && !concept.sources.includes("end-state"))
    .map((concept) => concept.term);

  if (strongerTaskTerms.length > 0) {
    for (const term of removableOperationalTerms) {
      primary.delete(term);
      outcome.delete(term);
      uncertain.delete(term);
      prerequisite.delete(term);
    }
  }

  if (primary.has("logout")) {
    primary.delete("login");
    outcome.delete("login");
    uncertain.delete("login");
    prerequisite.delete("login");
  }

  const hasNonAuthPrimary = [...primary].some((term) => !isAuthTerm(term));
  const hasStrongerNonAuth = strongerTaskTerms.length > 0;

  if (primary.has("login") && (hasNonAuthPrimary || hasStrongerNonAuth)) {
    primary.delete("login");
    outcome.delete("login");
    uncertain.delete("login");
    prerequisite.add("login");

    if (![...primary].some((term) => !isAuthTerm(term))) {
      const promotions = strongerNonAuthTerms.filter((term) => outcome.has(term));
      const candidates = promotions.length > 0 ? promotions : strongerNonAuthTerms;
      for (const term of candidates) {
        primary.add(term);
        outcome.delete(term);
      }
    }
  }

  if (hasLogout) {
    primary.add("logout");
    primary.delete("login");
    outcome.delete("login");
    uncertain.delete("login");
    prerequisite.delete("login");
    for (const term of removableOperationalTerms) {
      primary.delete(term);
      outcome.delete(term);
      uncertain.delete(term);
      prerequisite.delete(term);
    }
  } else if (!hasStrongerNonAuth && hasLogin) {
    prerequisite.delete("login");
    if (hasInvalidCredentialsAlert) {
      primary.add("login");
      primary.delete("invalid username or password alert");
      outcome.add("invalid username or password alert");
    } else if (hasNoResults) {
      primary.add("search");
      outcome.add("no results");
    } else if (hasDashboard) {
      primary.add("login");
      primary.delete("dashboard");
      outcome.add("dashboard");
    } else {
      primary.add("login");
    }
  }

  if (prerequisite.size > 1) {
    prerequisite.delete("dashboard");
  }

  const prerequisiteByRoot = new Map<string, string[]>();
  for (const term of prerequisite) {
    const root = firstToken(term);
    if (!root) {
      continue;
    }
    const group = prerequisiteByRoot.get(root) ?? [];
    group.push(term);
    prerequisiteByRoot.set(root, group);
  }

  for (const [root, terms] of prerequisiteByRoot) {
    if (terms.length < 2 || !focusRootTokens.has(root)) {
      continue;
    }

    const keep = [...terms].sort((left, right) => {
      const scoreDiff = scorePrerequisite(right, conceptByTerm, focusRootTokens) - scorePrerequisite(left, conceptByTerm, focusRootTokens);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      const lengthDiff = left.split(/\s+/).length - right.split(/\s+/).length;
      if (lengthDiff !== 0) {
        return lengthDiff;
      }

      return left.localeCompare(right);
    })[0];

    for (const term of terms) {
      if (term !== keep) {
        prerequisite.delete(term);
      }
    }
  }

  const compactedPrerequisites = [...prerequisite]
    .filter((term) => !primary.has(term) && !outcome.has(term) && !isOperationalTerm(term))
    .sort((left, right) => {
      const scoreDiff = scorePrerequisite(right, conceptByTerm, focusRootTokens) - scorePrerequisite(left, conceptByTerm, focusRootTokens);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return left.localeCompare(right);
    })
    .slice(0, 2);
  const compactedPrerequisiteSet = new Set(compactedPrerequisites);

  return {
    prerequisiteTerms: compactedPrerequisites,
    primaryTerms: [...primary].sort((a, b) => a.localeCompare(b)),
    outcomeTerms: [...outcome]
      .filter((term) => !primary.has(term) && !compactedPrerequisiteSet.has(term))
      .sort((a, b) => a.localeCompare(b)),
    uncertainTerms: [...uncertain]
      .filter((term) => !primary.has(term) && !compactedPrerequisiteSet.has(term) && !outcome.has(term))
      .sort((a, b) => a.localeCompare(b)),
  };
}
