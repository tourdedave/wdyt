import type { PrefixStats, PrefixStatsEntry, ReducedStep, SuppressedFlow, VocabularyEntry } from "./types.js";
import { resolveApprovedVocabularyTerm } from "./vocabulary.js";

type PrefixEntryAccumulator = {
  sequence: string[];
  flowKeys: Set<string>;
  downstreamSignatures: Set<string>;
  terminalCount: number;
};

function normalizeCanonicalStep(step: string, vocabulary: Iterable<VocabularyEntry>) {
  const canonical = resolveApprovedVocabularyTerm(step, vocabulary);
  return (canonical ?? step).trim().toUpperCase();
}

function normalizeCanonicalFlow(flow: string[], vocabulary: Iterable<VocabularyEntry>) {
  return flow.map((step) => normalizeCanonicalStep(step, vocabulary)).filter(Boolean);
}

export function collectPrefixStats(
  flows: string[][],
  vocabulary: Iterable<VocabularyEntry>,
  config: {
    maxPrefixLength?: number;
  } = {}
): PrefixStats<ReducedStep> {
  const maxPrefixLength = Math.max(1, config.maxPrefixLength ?? 3);
  const uniqueFlows = new Map<string, string[]>();

  for (const flow of flows) {
    const normalized = normalizeCanonicalFlow(flow, vocabulary);
    if (normalized.length === 0) {
      continue;
    }

    const signature = normalized.join("|");
    if (!uniqueFlows.has(signature)) {
      uniqueFlows.set(signature, normalized);
    }
  }

  const totalFlows = uniqueFlows.size;
  const prefixEntries = new Map<string, PrefixEntryAccumulator>();

  for (const flow of uniqueFlows.values()) {
    const flowKey = flow.join("|");
    const maxLength = Math.min(maxPrefixLength, flow.length);

    for (let length = 1; length <= maxLength; length += 1) {
      const sequence = flow.slice(0, length);
      const key = sequence.join("|");
      const accumulator = prefixEntries.get(key) ?? {
        sequence,
        flowKeys: new Set<string>(),
        downstreamSignatures: new Set<string>(),
        terminalCount: 0,
      };

      accumulator.flowKeys.add(flowKey);

      if (flow.length === length) {
        accumulator.terminalCount += 1;
      } else {
        accumulator.downstreamSignatures.add(flow.slice(length).join("|"));
      }

      prefixEntries.set(key, accumulator);
    }
  }

  const entries: PrefixStatsEntry<ReducedStep>[] = [...prefixEntries.values()]
    .map((entry) => ({
      sequence: entry.sequence as ReducedStep[],
      count: entry.flowKeys.size,
      frequencyPct: totalFlows === 0 ? 0 : entry.flowKeys.size / totalFlows,
      downstreamVariants: entry.downstreamSignatures.size,
      terminalCount: entry.terminalCount,
    }))
    .sort(
      (a, b) =>
        b.sequence.length - a.sequence.length ||
        b.frequencyPct - a.frequencyPct ||
        a.sequence.join("|").localeCompare(b.sequence.join("|"))
    );

  return {
    totalFlows,
    entries,
  };
}

function qualifiesSharedPrefix(
  entry: PrefixStatsEntry,
  config: {
    minFrequencyPct: number;
  }
) {
  if (entry.frequencyPct <= config.minFrequencyPct) {
    return false;
  }

  if (entry.downstreamVariants < 2) {
    return false;
  }

  return entry.terminalCount < entry.count / 2;
}

export function suppressSharedPrefix(
  flow: ReducedStep[],
  stats: PrefixStats<ReducedStep>,
  config: {
    minFrequencyPct: number;
    maxPrefixLength: number;
  } = {
    minFrequencyPct: 0.5,
    maxPrefixLength: 3,
  }
): SuppressedFlow<ReducedStep> {
  const maxPrefixLength = Math.min(config.maxPrefixLength, Math.max(0, flow.length - 1));

  if (flow.length <= 1 || stats.totalFlows === 0 || maxPrefixLength === 0) {
    return {
      prerequisites: [],
      primary: [...flow],
    };
  }

  let matchedLength = 0;

  for (let length = maxPrefixLength; length >= 1; length -= 1) {
    const prefix = flow.slice(0, length);
    const entry = stats.entries.find((candidate) => candidate.sequence.length === length);

    if (!entry) {
      continue;
    }

    const exactMatch = stats.entries.find(
      (candidate) =>
        candidate.sequence.length === length &&
        candidate.sequence.every((step, index) => step === prefix[index])
    );

    if (exactMatch && qualifiesSharedPrefix(exactMatch, config)) {
      matchedLength = length;
      break;
    }
  }

  if (matchedLength === 0) {
    return {
      prerequisites: [],
      primary: [...flow],
    };
  }

  return {
    prerequisites: flow.slice(0, matchedLength),
    primary: flow.slice(matchedLength),
  };
}
