const statusEl = document.getElementById("status");
const detailsEl = document.getElementById("details");

function setStatus(status: "ok" | "error", message: string) {
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.setAttribute("data-status", status);
  }
}

function setDetails(message: string) {
  if (detailsEl) {
    detailsEl.textContent = message;
  }
}

async function main() {
  const params = new URLSearchParams(window.location.search);
  const runId = params.get("runId");
  const serverUrl = params.get("serverUrl") ?? "http://127.0.0.1:3876";
  const mode = params.get("mode") ?? "bind";

  if (mode === "sync") {
    chrome.runtime.sendMessage({ kind: "SYNC_RUN", serverUrl }, (response) => {
      const result = response as { ok?: boolean; browserSessionId?: string; error?: string } | undefined;

      if (!result?.ok) {
        setStatus("error", "WDIT sync failed");
        setDetails(result?.error ?? "Unknown error");
        return;
      }

      setStatus("ok", "WDIT sync completed");
      setDetails(`browserSessionId=${result.browserSessionId ?? "unknown"}`);
    });
    return;
  }

  if (!runId) {
    setStatus("error", "Missing run id");
    return;
  }

  chrome.runtime.sendMessage({ kind: "BIND_RUN", serverUrl, runId }, (response) => {
    const result = response as
      | {
          ok?: boolean;
          runId?: string;
          browserSessionId?: string;
          error?: string;
        }
      | undefined;

    if (!result?.ok) {
      setStatus("error", "WDIT bind failed");
      setDetails(result?.error ?? "Unknown error");
      return;
    }

    setStatus("ok", "WDIT bound");
    setDetails(`runId=${runId} browserSessionId=${result.browserSessionId}`);
  });
}

void main();
