export const DEFAULT_LLM_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_LLM_API_KEY = "ollama";
export const DEFAULT_LLM_MODEL = "mistral:instruct";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJsonObject(raw: string) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let startIndex = -1;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        startIndex = index;
      }
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        return raw.slice(startIndex, index + 1);
      }
    }
  }

  throw new Error("LLM fake mode could not locate JSON input payload");
}

function normalizeToken(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function toDescriptorCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function maybeReturnFakeResponse(input: {
  systemPrompt: string;
  userPrompt: string;
}) {
  if (process.env.WDYT_LLM_FAKE !== "1") {
    return null;
  }

  const latencyMs = Number.parseInt(process.env.WDYT_LLM_FAKE_LATENCY_MS ?? "0", 10);
  if (Number.isFinite(latencyMs) && latencyMs > 0) {
    await sleep(latencyMs);
  }

  const payload = JSON.parse(extractJsonObject(input.userPrompt)) as Record<string, unknown>;

  if (input.systemPrompt.startsWith("You are classifying raw observed evidence")) {
    const evidenceItems = Array.isArray(payload.evidenceItems) ? payload.evidenceItems as Array<Record<string, unknown>> : [];
    return {
      items: evidenceItems.map((item) => {
        const value = String(item.value ?? "").toLowerCase();
        const inferredBucket = typeof item.inferredBucket === "string" ? item.inferredBucket : "action";
        const kind = String(item.kind ?? "");
        let bucket = inferredBucket;
        if (kind === "alert" || kind === "title" || kind === "heading" || (kind === "url" && (value.includes("/results") || value.includes("/settings") || value.includes("/reports") || value.includes("/dashboard")))) {
          bucket = "end-state";
        } else if (value.includes("sign in") || value.includes("open ") || value.includes("search")) {
          bucket = "action";
        }

        return {
          id: String(item.id ?? ""),
          bucket,
          confidence: 0.9,
          rationale: "Synthetic classification",
        };
      }),
    };
  }

  if (input.systemPrompt.startsWith("You are resolving software-test evidence into semantic concepts")) {
    const hints = Array.isArray(payload.candidateConceptHints) ? payload.candidateConceptHints as string[] : [];
    const evidenceItems = Array.isArray(payload.evidenceItems) ? payload.evidenceItems as Array<Record<string, unknown>> : [];
    const defaultItemIds = evidenceItems.slice(0, 2).map((item) => String(item.id ?? "")).filter(Boolean);
    return {
      concepts: hints.slice(0, 4).map((term) => ({
        term,
        itemIds: defaultItemIds.length > 0 ? defaultItemIds : ["synthetic-evidence"],
        confidence: 0.9,
      })),
    };
  }

  if (input.systemPrompt.startsWith("You are classifying semantic flow terms for WDYT")) {
    const flowTerms = Array.isArray(payload.flowTerms) ? payload.flowTerms as string[] : [];
    const setupTerms = new Set(Array.isArray(payload.setupTerms) ? payload.setupTerms as string[] : []);
    const actionTerms = new Set(Array.isArray(payload.actionTerms) ? payload.actionTerms as string[] : []);
    const endStateTerms = new Set(Array.isArray(payload.endStateTerms) ? payload.endStateTerms as string[] : []);
    return {
      termRoles: flowTerms.map((term) => {
        const normalized = normalizeToken(term);
        let role = "uncertain";
        if (normalized === "login" || setupTerms.has(term)) {
          role = "prerequisite";
        } else if (normalized.includes("result") || normalized.includes("alert") || normalized.includes("no results") || endStateTerms.has(term)) {
          role = "outcome";
        } else if (actionTerms.has(term) || normalized) {
          role = "primary";
        }
        return { term, role };
      }),
    };
  }

  if (input.systemPrompt.startsWith("You are labeling observed software test flows for WDYT")) {
    const primaryTerms = Array.isArray(payload.primaryTerms) ? payload.primaryTerms as string[] : [];
    const outcomeTerms = Array.isArray(payload.outcomeTerms) ? payload.outcomeTerms as string[] : [];
    const chosenPrimary = primaryTerms[0] ?? "observed behavior";
    const chosenOutcome = outcomeTerms[0] ?? "";
    const descriptor = chosenOutcome
      ? `View ${toDescriptorCase(chosenPrimary)} ${toDescriptorCase(chosenOutcome)}`
      : `View ${toDescriptorCase(chosenPrimary)}`;
    return {
      descriptor,
      approvedVocab: [],
      proposedVocab: [...new Set([chosenPrimary, chosenOutcome].filter(Boolean))],
      confidence: 0.78,
      rationale: "Synthetic proposal generated from provided primary and outcome terms.",
    };
  }

  return null;
}

export async function requestJsonCompletion(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
}) {
  const fakeResponse = await maybeReturnFakeResponse(input);
  if (fakeResponse) {
    return fakeResponse;
  }

  const response = await fetch(new URL("chat/completions", `${input.baseUrl.replace(/\/?$/, "/")}`).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      response_format: { type: "json_object" },
      temperature: 0.2,
      stream: false,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM proposal failed with status ${response.status}: ${errorText}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };
  const content = body.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("LLM response did not include message content");
  }

  return JSON.parse(content) as unknown;
}
