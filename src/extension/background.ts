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

type ActiveCapture = {
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
  testName: string;
  startedAt: number;
  events: BufferedEvent[];
  nextSeq: number;
  lastActivityAt: number;
  lastObservedEndState?: {
    finalUrl?: string;
    title?: string | null;
    heading?: string | null;
    alertText?: string | null;
  };
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

type BeginCaptureMessage = {
  kind: "BEGIN_CAPTURE";
  serverUrl: string;
  suiteName?: string;
  testName?: string;
  environment?: ActiveCapture["environment"];
};

type FinalizeCaptureMessage = {
  kind: "FINALIZE_CAPTURE";
  reason?: "completed" | "timeout";
};

type SnapshotEndStateMessage = {
  kind: "SNAPSHOT_END_STATE";
  endState: NonNullable<ActiveCapture["lastObservedEndState"]>;
};

type ExtensionMessage =
  | AppendEventMessage
  | GetStateMessage
  | BeginCaptureMessage
  | FinalizeCaptureMessage
  | SnapshotEndStateMessage;

const STORAGE_KEY = "backgroundState";
const TIMEOUT_MS = 60_000;
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
let browserSessionId: string = crypto.randomUUID();

let activeCapture: ActiveCapture | null = null;

function normalizeName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function createSuiteInfo(name?: string) {
  const nextName = name?.trim() || "unknown-suite";
  return {
    id: normalizeName(nextName),
    name: nextName,
    normalizedName: normalizeName(nextName),
  };
}

function saveState() {
  chrome.storage.local.set({
    [STORAGE_KEY]: {
      browserSessionId,
      activeCapture,
    },
  });
}

function loadState() {
  chrome.storage.local.get(STORAGE_KEY, (items) => {
    const stored = items[STORAGE_KEY] as
      | {
          browserSessionId?: string;
          activeCapture?: ActiveCapture | null;
        }
      | undefined;

    if (stored?.browserSessionId) {
      browserSessionId = stored.browserSessionId;
    }

    if (stored?.activeCapture) {
      activeCapture = stored.activeCapture;
      scheduleTimeout(activeCapture.lastActivityAt);
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
  if (!activeCapture) {
    return;
  }

  const nextEvent: BufferedEvent = {
    ...event,
    ts: event.ts ?? Date.now(),
    seq: activeCapture.nextSeq,
  };

  activeCapture.events.push(nextEvent);
  activeCapture.nextSeq += 1;
  activeCapture.lastActivityAt = nextEvent.ts;
  scheduleTimeout(activeCapture.lastActivityAt);
  saveState();
}

function snapshotEndState(endState: SnapshotEndStateMessage["endState"]) {
  if (!activeCapture) {
    return;
  }

  activeCapture.lastObservedEndState = endState;
  saveState();
}

function beginCapture(message: BeginCaptureMessage) {
  clearTimeoutAlarm();
  activeCapture = {
    serverUrl: message.serverUrl,
    suite: createSuiteInfo(message.suiteName),
    environment: message.environment,
    testName: message.testName?.trim() || "unnamed-test",
    startedAt: Date.now(),
    events: [],
    nextSeq: 0,
    lastActivityAt: Date.now(),
  };

  scheduleTimeout(activeCapture.lastActivityAt);
  saveState();

  return {
    ok: true,
    browserSessionId,
  };
}

async function finalizeCapture(reason: "completed" | "timeout") {
  if (!activeCapture) {
    return {
      ok: true,
      browserSessionId,
      finalized: false,
    };
  }

  const captureToPersist = activeCapture;
  const endState = captureToPersist.lastObservedEndState ?? (await captureEndState());
  const payload = {
    suite: captureToPersist.suite,
    environment: captureToPersist.environment,
    endState,
    run: {
      testName: captureToPersist.testName,
      startedAt: captureToPersist.startedAt,
      endedAt: Date.now(),
      reason,
    },
    events: captureToPersist.events,
  };

  activeCapture = null;
  clearTimeoutAlarm();
  saveState();

  try {
    await fetch(`${captureToPersist.serverUrl}/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.warn("WDYT ingest failed", error);
  }

  return {
    ok: true,
    browserSessionId,
    finalized: true,
  };
}

chrome.runtime.onInstalled.addListener(loadState);
chrome.runtime.onStartup.addListener(loadState);
loadState();

chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
  const message = rawMessage as ExtensionMessage;

  if (message.kind === "GET_STATE") {
    sendResponse({
      bound: activeCapture !== null,
      browserSessionId,
    });
    return;
  }

  if (message.kind === "APPEND_EVENT") {
    appendEvent(message.event);
    sendResponse({ ok: true });
    return;
  }

  if (message.kind === "SNAPSHOT_END_STATE") {
    snapshotEndState(message.endState);
    sendResponse({ ok: true });
    return;
  }

  if (message.kind === "BEGIN_CAPTURE") {
    try {
      sendResponse(beginCapture(message));
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    }
    return;
  }

  if (message.kind === "FINALIZE_CAPTURE") {
    void finalizeCapture(message.reason ?? "completed")
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }));
    return true;
  }

  sendResponse({ ok: false, browserSessionId });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "wdyt-timeout") {
    return;
  }

  if (!activeCapture) {
    return;
  }

  if (Date.now() - activeCapture.lastActivityAt >= TIMEOUT_MS) {
    void finalizeCapture("timeout");
    return;
  }

  scheduleTimeout(activeCapture.lastActivityAt);
});
