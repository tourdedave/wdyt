type BridgeDetail =
  | {
      kind: "CAPTURE_EVENT";
      event: {
        type: "navigate";
        url: string;
      };
    };

const BRIDGE_EVENT = "wdit:bridge";

function emit(detail: BridgeDetail) {
  document.dispatchEvent(new CustomEvent(BRIDGE_EVENT, { detail }));
}

const originalPushState = history.pushState;

history.pushState = function (...args) {
  const result = originalPushState.apply(this, args);
  emit({
    kind: "CAPTURE_EVENT",
    event: {
      type: "navigate",
      url: window.location.href,
    },
  });
  return result;
};

window.addEventListener("popstate", () => {
  emit({
    kind: "CAPTURE_EVENT",
    event: {
      type: "navigate",
      url: window.location.href,
    },
  });
});
