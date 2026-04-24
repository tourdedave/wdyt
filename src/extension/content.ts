type PageEventType = "click" | "input" | "change" | "submit" | "navigate";

type PageBridgeMessage =
  | {
      kind: "CAPTURE_EVENT";
      event: {
        type: "navigate";
        url?: string;
      };
    };

type EndStateSnapshot = {
  finalUrl: string;
  title: string | null;
  heading: string | null;
  alertText: string | null;
};

const BRIDGE_EVENT = "wdyt:bridge";
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

function isBootstrapPage() {
  return window.location.pathname === "/bootstrap";
}

function extractTarget(element: Element) {
  const candidate = element as HTMLElement & { value?: string };
  const text = (candidate.innerText || candidate.value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);

  return {
    tag: element.tagName.toLowerCase(),
    text: text || null,
  };
}

function sendRuntimeMessage(message: unknown) {
  chrome.runtime.sendMessage(message);
}

function readEndStateSnapshot(): EndStateSnapshot {
  const heading = document.querySelector("h1")?.textContent?.trim() ?? null;
  const alertText = document.querySelector('[role="alert"]')?.textContent?.replace(/\s+/g, " ").trim() ?? null;

  return {
    finalUrl: window.location.href,
    title: document.title || null,
    heading: heading || null,
    alertText: alertText || null,
  };
}

function snapshotEndState() {
  if (isBootstrapPage()) {
    return;
  }

  sendRuntimeMessage({
    kind: "SNAPSHOT_END_STATE",
    endState: readEndStateSnapshot(),
  });
}

function sendCapturedDomEvent(type: Exclude<PageEventType, "navigate">, target: EventTarget | null) {
  if (isBootstrapPage()) {
    return;
  }

  if (!(target instanceof Element)) {
    return;
  }

  sendRuntimeMessage({
    kind: "APPEND_EVENT",
    event: {
      type,
      target: extractTarget(target),
    },
  });
}

function emitInitialNavigate() {
  if (isBootstrapPage()) {
    return;
  }

  sendRuntimeMessage({
    kind: "APPEND_EVENT",
    event: {
      type: "navigate",
      url: window.location.href,
    },
  });
}

function injectBridge() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-bridge.js");

  (document.documentElement || document.head).appendChild(script);
  script.remove();
}

function setupCapture() {
  document.addEventListener("click", (event) => sendCapturedDomEvent("click", event.target), true);
  document.addEventListener("input", (event) => sendCapturedDomEvent("input", event.target), true);
  document.addEventListener("change", (event) => sendCapturedDomEvent("change", event.target), true);
  document.addEventListener("submit", (event) => sendCapturedDomEvent("submit", event.target), true);
  window.addEventListener("pagehide", snapshotEndState, true);
  window.addEventListener("beforeunload", snapshotEndState, true);

  document.addEventListener(BRIDGE_EVENT, (event) => {
    const customEvent = event as CustomEvent<PageBridgeMessage>;
    const detail = customEvent.detail;

    if (!detail) {
      return;
    }

    if (detail.kind === "CAPTURE_EVENT") {
      sendRuntimeMessage({
        kind: "APPEND_EVENT",
        event: detail.event,
      });
    }
  });

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      !event.data ||
      (event.data.kind !== "WDYT_BEGIN_CAPTURE" && event.data.kind !== "WDYT_FINALIZE_CAPTURE")
    ) {
      return;
    }

    const runtimeMessage =
      event.data.kind === "WDYT_BEGIN_CAPTURE"
        ? {
            kind: "BEGIN_CAPTURE",
            serverUrl: event.data.serverUrl,
            suiteName: event.data.suiteName,
            testName: event.data.testName,
            environment: event.data.environment,
          }
        : {
            kind: "FINALIZE_CAPTURE",
            reason: event.data.reason,
          };

    chrome.runtime.sendMessage(
      runtimeMessage,
      (response) => {
        const result =
          (response as { ok?: boolean; browserSessionId?: string; error?: string } | undefined) ?? {};

        window.postMessage(
          {
            kind: "WDYT_CAPTURE_RESULT",
            ok: Boolean(result.ok),
            browserSessionId: result.browserSessionId,
            error: result.error,
          },
          "*"
        );
      }
    );
  });
}

injectBridge();
setupCapture();

console.log(`[WDYT] content script loaded v${EXTENSION_VERSION} on ${window.location.href}`);

chrome.runtime.sendMessage({ kind: "GET_STATE" }, (response) => {
  const state = response as { bound?: boolean; browserSessionId?: string } | undefined;

  if (state?.bound && !isBootstrapPage()) {
    emitInitialNavigate();
  }

  if (state?.browserSessionId) {
    console.log(`[WDYT] browser session ${state.browserSessionId}`);
  }
});
