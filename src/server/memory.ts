const MEMORY_LOGGING_ENABLED = process.env.WDYT_LOG_MEMORY === "1";

export const MEMORY_LOG_INTERVAL_MS = (() => {
  const parsed = Number.parseInt(process.env.WDYT_LOG_MEMORY_INTERVAL_MS ?? "30000", 10);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    return 30_000;
  }

  return parsed;
})();

function formatMemorySize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 MB";
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function logProcessMemoryUsage(context: string) {
  if (!MEMORY_LOGGING_ENABLED) {
    return;
  }

  const usage = process.memoryUsage();
  console.log(
    `[WDYT] memory context=${context} rss=${formatMemorySize(usage.rss)} heapUsed=${formatMemorySize(usage.heapUsed)} heapTotal=${formatMemorySize(usage.heapTotal)} external=${formatMemorySize(usage.external)} arrayBuffers=${formatMemorySize(usage.arrayBuffers)}`
  );
}

export function startMemoryLogging() {
  if (!MEMORY_LOGGING_ENABLED) {
    return;
  }

  logProcessMemoryUsage("startup");
  const interval = setInterval(() => {
    logProcessMemoryUsage("interval");
  }, MEMORY_LOG_INTERVAL_MS);

  interval.unref();
}
