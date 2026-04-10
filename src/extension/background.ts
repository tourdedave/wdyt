type EventType = "click" | "input" | "change" | "submit" | "navigate";

type BufferedEvent = {
  type: EventType;
  ts: number;
  seq: number;
  url?: string;
  target?: {
    tag: string;
    text: string | null;
  };
};

type ActiveRun = {
  suite: {
    id: string;
    name: string;
    normalizedName: string;
  };
  run: {
    id: string;
    testName: string;
    startedAt: number;
  };
  events: BufferedEvent[];
  nextSeq: number;
  lastActivityAt: number;
};

type StartRunMessage = {
  kind: "START_RUN";
  suite: string;
  testName: string;
};

type EndRunMessage = {
  kind: "END_RUN";
};

type AppendEventMessage = {
  kind: "APPEND_EVENT";
  event: Omit<BufferedEvent, "seq" | "ts"> & {
    ts?: number;
  };
};

type GetStateMessage = {
  kind: "GET_STATE";
};

type ExtensionMessage = StartRunMessage | EndRunMessage | AppendEventMessage | GetStateMessage;

const STORAGE_KEY = "activeRuns";
const INGEST_URL = "http://127.0.0.1:3876/ingest";
const TIMEOUT_MS = 60_000;
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

const activeRuns = new Map<number, ActiveRun>();

function normalizeName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function createSuite(name: string) {
  const normalizedName = normalizeName(name);
  return {
    id: normalizedName,
    name,
    normalizedName,
  };
}

function alarmName(tabId: number) {
  return `wdit-timeout-${tabId}`;
}

function saveRuns() {
  const serialized = Object.fromEntries(activeRuns.entries());
  chrome.storage.local.set({ [STORAGE_KEY]: serialized });
}

function loadRuns() {
  chrome.storage.local.get(STORAGE_KEY, (items) => {
    const stored = (items[STORAGE_KEY] as Record<string, ActiveRun> | undefined) ?? {};

    for (const [tabId, run] of Object.entries(stored)) {
      activeRuns.set(Number(tabId), run);
      scheduleTimeout(Number(tabId), run.lastActivityAt);
    }
  });
}

function scheduleTimeout(tabId: number, fromTs: number) {
  chrome.alarms.create(alarmName(tabId), { when: fromTs + TIMEOUT_MS });
}

function clearTimeoutAlarm(tabId: number) {
  chrome.alarms.clear(alarmName(tabId));
}

async function finalizeRun(tabId: number, reason: "completed" | "timeout") {
  const activeRun = activeRuns.get(tabId);

  if (!activeRun) {
    return;
  }

  const payload = {
    suite: activeRun.suite,
    run: {
      id: activeRun.run.id,
      testName: activeRun.run.testName,
      startedAt: activeRun.run.startedAt,
      endedAt: Date.now(),
      reason,
    },
    events: activeRun.events,
  };

  activeRuns.delete(tabId);
  clearTimeoutAlarm(tabId);
  saveRuns();

  try {
    await fetch(INGEST_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.warn("WDIT ingest failed", error);
  }
}

function appendEvent(tabId: number, event: AppendEventMessage["event"]) {
  const activeRun = activeRuns.get(tabId);

  if (!activeRun) {
    return;
  }

  const nextEvent: BufferedEvent = {
    ...event,
    ts: event.ts ?? Date.now(),
    seq: activeRun.nextSeq,
  };

  activeRun.events.push(nextEvent);
  activeRun.nextSeq += 1;
  activeRun.lastActivityAt = nextEvent.ts;
  scheduleTimeout(tabId, activeRun.lastActivityAt);
  saveRuns();
}

function handleStartRun(tabId: number, message: StartRunMessage) {
  const now = Date.now();
  const run: ActiveRun = {
    suite: createSuite(message.suite),
    run: {
      id: crypto.randomUUID(),
      testName: message.testName,
      startedAt: now,
    },
    events: [],
    nextSeq: 0,
    lastActivityAt: now,
  };

  activeRuns.set(tabId, run);
  scheduleTimeout(tabId, now);
  saveRuns();
}

chrome.runtime.onInstalled.addListener(loadRuns);
chrome.runtime.onStartup.addListener(loadRuns);
loadRuns();

console.log(`[WDIT] background loaded v${EXTENSION_VERSION}`);

chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const message = rawMessage as ExtensionMessage;

  if (message.kind === "GET_STATE") {
    sendResponse({ active: typeof tabId === "number" && activeRuns.has(tabId) });
    return;
  }

  if (typeof tabId !== "number") {
    sendResponse({ ok: false });
    return;
  }

  if (message.kind === "START_RUN") {
    handleStartRun(tabId, message);
    sendResponse({ ok: true });
    return;
  }

  if (message.kind === "APPEND_EVENT") {
    appendEvent(tabId, message.event);
    sendResponse({ ok: true });
    return;
  }

  if (message.kind === "END_RUN") {
    void finalizeRun(tabId, "completed");
    sendResponse({ ok: true });
    return;
  }

  sendResponse({ ok: false });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith("wdit-timeout-")) {
    return;
  }

  const tabId = Number(alarm.name.replace("wdit-timeout-", ""));
  const activeRun = activeRuns.get(tabId);

  if (!activeRun) {
    return;
  }

  if (Date.now() - activeRun.lastActivityAt >= TIMEOUT_MS) {
    void finalizeRun(tabId, "timeout");
    return;
  }

  scheduleTimeout(tabId, activeRun.lastActivityAt);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void finalizeRun(tabId, "timeout");
});
