type PageEventType = "click" | "input" | "change" | "submit" | "navigate";

type PageBridgeMessage =
  | { kind: "START_RUN"; suite: string; testName: string }
  | { kind: "END_RUN" }
  | {
      kind: "CAPTURE_EVENT";
      event: {
        type: PageEventType;
        url?: string;
      };
    };

const BRIDGE_EVENT = "wdit:bridge";

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

function sendCapturedDomEvent(type: Exclude<PageEventType, "navigate">, target: EventTarget | null) {
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
  script.textContent = `
    (() => {
      const EVENT_NAME = ${JSON.stringify(BRIDGE_EVENT)};
      const emit = (detail) => document.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
      const wrapHistory = () => {
        const originalPushState = history.pushState;
        history.pushState = function (...args) {
          const result = originalPushState.apply(this, args);
          emit({ kind: "CAPTURE_EVENT", event: { type: "navigate", url: location.href } });
          return result;
        };
      };
      wrapHistory();
      window.addEventListener("popstate", () => {
        emit({ kind: "CAPTURE_EVENT", event: { type: "navigate", url: location.href } });
      });
      window.startTest = ({ suite, testName }) => {
        emit({ kind: "START_RUN", suite, testName });
      };
      window.endTest = () => {
        emit({ kind: "END_RUN" });
      };
    })();
  `;

  (document.documentElement || document.head).appendChild(script);
  script.remove();
}

function setupCapture() {
  document.addEventListener("click", (event) => sendCapturedDomEvent("click", event.target), true);
  document.addEventListener("input", (event) => sendCapturedDomEvent("input", event.target), true);
  document.addEventListener("change", (event) => sendCapturedDomEvent("change", event.target), true);
  document.addEventListener("submit", (event) => sendCapturedDomEvent("submit", event.target), true);

  document.addEventListener(BRIDGE_EVENT, (event) => {
    const customEvent = event as CustomEvent<PageBridgeMessage>;
    const detail = customEvent.detail;

    if (!detail) {
      return;
    }

    if (detail.kind === "START_RUN") {
      sendRuntimeMessage(detail);
      emitInitialNavigate();
      return;
    }

    if (detail.kind === "END_RUN") {
      sendRuntimeMessage(detail);
      return;
    }

    if (detail.kind === "CAPTURE_EVENT") {
      sendRuntimeMessage({
        kind: "APPEND_EVENT",
        event: detail.event,
      });
    }
  });
}

injectBridge();
setupCapture();

chrome.runtime.sendMessage({ kind: "GET_STATE" }, (response) => {
  const state = response as { active?: boolean } | undefined;

  if (state?.active) {
    emitInitialNavigate();
  }
});
