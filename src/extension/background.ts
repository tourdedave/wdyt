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

type BoundRun = {
  serverUrl: string;
  suite: {
    id: string;
    name: string;
    normalizedName: string;
  };
  environment?: {
    browser?: {
      family: string;
      version: string;
      source: "bootstrap-request";
    };
    tool?: string;
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

type AppendEventMessage = {
  kind: "APPEND_EVENT";
  event: Omit<BufferedEvent, "seq" | "ts"> & {
    ts?: number;
  };
};

type GetStateMessage = {
  kind: "GET_STATE";
};

type BindRunMessage = {
  kind: "BIND_RUN";
  serverUrl: string;
  runId: string;
};

type SyncRunMessage = {
  kind: "SYNC_RUN";
  serverUrl?: string;
};

type ExtensionMessage = AppendEventMessage | GetStateMessage | BindRunMessage | SyncRunMessage;

const STORAGE_KEY = "backgroundState";
const TIMEOUT_MS = 60_000;
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const SYNC_ALARM = "wdyt-sync";
const DEFAULT_SERVER_URL = "http://127.0.0.1:3876";
let browserSessionId: string = crypto.randomUUID();

let activeRun: BoundRun | null = null;

function saveState() {
  chrome.storage.local.set({
    [STORAGE_KEY]: {
      browserSessionId,
      activeRun,
    },
  });
}

function loadState() {
  chrome.storage.local.get(STORAGE_KEY, (items) => {
    const stored = items[STORAGE_KEY] as
      | {
          browserSessionId?: string;
          activeRun?: BoundRun | null;
        }
      | undefined;

    if (stored?.browserSessionId) {
      browserSessionId = stored.browserSessionId;
    }

    if (stored?.activeRun) {
      activeRun = stored.activeRun;
      scheduleTimeout(activeRun.lastActivityAt);
      scheduleSync();
    }

    saveState();
    console.log(`[WDYT] background loaded v${EXTENSION_VERSION} session=${browserSessionId}`);
  });
}

function scheduleTimeout(fromTs: number) {
  chrome.alarms.create("wdyt-timeout", { when: fromTs + TIMEOUT_MS });
}

function clearTimeoutAlarm() {
  chrome.alarms.clear("wdyt-timeout");
}

function scheduleSync() {
  chrome.alarms.create(SYNC_ALARM, { when: Date.now() + 2_000 });
}

async function finalizeRun(reason: "completed" | "timeout") {
  if (!activeRun) {
    return;
  }

  const runToPersist = activeRun;
  const endState = await captureEndState();
  const payload = {
    suite: runToPersist.suite,
    environment: runToPersist.environment,
    endState,
    run: {
      id: runToPersist.run.id,
      testName: runToPersist.run.testName,
      startedAt: runToPersist.run.startedAt,
      endedAt: Date.now(),
      reason,
    },
    events: runToPersist.events,
  };

  activeRun = null;
  clearTimeoutAlarm();
  chrome.alarms.clear(SYNC_ALARM);
  saveState();

  try {
    await fetch(`${runToPersist.serverUrl}/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.warn("WDYT ingest failed", error);
  }
}

async function captureEndState() {
  const tabs = await new Promise<Array<{ id?: number; url?: string }>>((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, resolve);
  });

  const tabId = tabs[0]?.id;

  if (typeof tabId !== "number") {
    return undefined;
  }

  try {
    const results = await new Promise<Array<{ result: unknown }>>((resolve, reject) => {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          func: () => {
            const heading = document.querySelector("h1")?.textContent?.trim() ?? null;
            const alertText =
              document.querySelector('[role="alert"]')?.textContent?.replace(/\s+/g, " ").trim() ?? null;

            return {
              finalUrl: window.location.href,
              title: document.title || null,
              heading: heading || null,
              alertText: alertText || null,
            };
          },
        },
        (injectionResults) => {
          const error = chrome.runtime.lastError;

          if (error?.message) {
            reject(new Error(error.message));
            return;
          }

          resolve(injectionResults);
        }
      );
    });

    return results[0]?.result as
      | {
          finalUrl?: string;
          title?: string | null;
          heading?: string | null;
          alertText?: string | null;
        }
      | undefined;
  } catch (error) {
    console.warn("WDYT end-state capture failed", error);
    return undefined;
  }
}

function appendEvent(event: AppendEventMessage["event"]) {
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
  scheduleTimeout(activeRun.lastActivityAt);
  saveState();
}

async function bindRun(message: BindRunMessage) {
  const response = await fetch(`${message.serverUrl}/bindings/bind`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      browserSessionId,
      runId: message.runId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Bind failed with status ${response.status}`);
  }

  const result = (await response.json()) as {
    suite: BoundRun["suite"];
    environment?: BoundRun["environment"];
    run: BoundRun["run"];
  };

  activeRun = {
    serverUrl: message.serverUrl,
    suite: result.suite,
    environment: result.environment,
    run: result.run,
    events: [],
    nextSeq: 0,
    lastActivityAt: Date.now(),
  };

  scheduleTimeout(activeRun.lastActivityAt);
  scheduleSync();
  saveState();

  return {
    ok: true,
    runId: activeRun.run.id,
    browserSessionId,
  };
}

async function syncRun(serverUrl = activeRun?.serverUrl ?? DEFAULT_SERVER_URL) {
  if (!activeRun) {
    return {
      ok: true,
      bound: false,
      browserSessionId,
    };
  }

  const url = new URL("/bindings/current", serverUrl);
  url.searchParams.set("browserSessionId", browserSessionId);

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Sync failed with status ${response.status}`);
  }

  const result = (await response.json()) as
    | { bound: false }
    | {
        bound: true;
        run: BoundRun["run"];
        status: "bound" | "ending";
        endReason: "completed" | "timeout" | null;
      };

  if (!result.bound) {
    return {
      ok: true,
      bound: false,
      browserSessionId,
    };
  }

  if (result.run.id !== activeRun.run.id) {
    return {
      ok: true,
      bound: true,
      browserSessionId,
      runId: activeRun.run.id,
    };
  }

  if (result.status === "ending") {
    await finalizeRun(result.endReason ?? "completed");
    return {
      ok: true,
      bound: false,
      browserSessionId,
      finalized: true,
    };
  }

  scheduleSync();
  return {
    ok: true,
    bound: true,
    browserSessionId,
    runId: activeRun.run.id,
  };
}

chrome.runtime.onInstalled.addListener(loadState);
chrome.runtime.onStartup.addListener(loadState);
loadState();

chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
  const message = rawMessage as ExtensionMessage;

  if (message.kind === "GET_STATE") {
    sendResponse({
      bound: activeRun !== null,
      browserSessionId,
      runId: activeRun?.run.id ?? null,
    });
    return;
  }

  if (message.kind === "APPEND_EVENT") {
    appendEvent(message.event);
    sendResponse({ ok: true });
    return;
  }

  if (message.kind === "BIND_RUN") {
    void bindRun(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }));
    return true;
  }

  if (message.kind === "SYNC_RUN") {
    void syncRun(message.serverUrl)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }));
    return true;
  }

  sendResponse({ ok: false, browserSessionId });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) {
    void syncRun();
    return;
  }

  if (alarm.name !== "wdyt-timeout") {
    return;
  }

  if (!activeRun) {
    return;
  }

  if (Date.now() - activeRun.lastActivityAt >= TIMEOUT_MS) {
    void finalizeRun("timeout");
    return;
  }

  scheduleTimeout(activeRun.lastActivityAt);
});
