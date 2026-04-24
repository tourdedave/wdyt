import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const backgroundPath = path.join(repoRoot, "dist", "extension", "background.js");

function createListenerRegistry() {
  let listener = null;

  return {
    get listener() {
      return listener;
    },
    addListener(nextListener) {
      listener = nextListener;
    },
  };
}

function sendRuntimeMessage(listener, message) {
  return new Promise((resolve) => {
    const result = listener(message, {}, resolve);

    if (result !== true) {
      resolve(undefined);
    }
  });
}

test("background captures end-state fields before ingest", async () => {
  const script = await readFile(backgroundPath, "utf8");
  const storedState = {};
  const createdAlarms = [];
  const clearedAlarms = [];
  const fetchCalls = [];

  const onInstalled = createListenerRegistry();
  const onStartup = createListenerRegistry();
  const onMessage = createListenerRegistry();
  const onAlarm = createListenerRegistry();

  const context = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    Date,
    crypto: {
      randomUUID: () => "browser-session-1",
    },
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), options });

      if (String(url).endsWith("/ingest")) {
        return {
          ok: true,
          async json() {
            return {};
          },
        };
      }

      throw new Error(`Unexpected fetch ${String(url)}`);
    },
    chrome: {
      runtime: {
        getManifest: () => ({ version: "0.1.0" }),
        onInstalled,
        onStartup,
        onMessage,
      },
      storage: {
        local: {
          get(key, callback) {
            callback({ [key]: storedState[key] });
          },
          set(value) {
            Object.assign(storedState, value);
          },
        },
      },
      alarms: {
        create(name, info) {
          createdAlarms.push({ name, info });
        },
        clear(name) {
          clearedAlarms.push(name);
        },
        onAlarm,
      },
      tabs: {
        query(_queryInfo, callback) {
          callback([{ id: 101, url: "http://127.0.0.1:4010/dashboard" }]);
        },
      },
      scripting: {
        executeScript(options, callback) {
          const result = options.func();
          callback([{ result }]);
        },
      },
    },
    window: {
      location: {
        href: "http://127.0.0.1:4010/dashboard",
      },
    },
    document: {
      title: "Dashboard",
      querySelector(selector) {
        if (selector === "h1") {
          return { textContent: "Dashboard" };
        }

        if (selector === '[role="alert"]') {
          return { textContent: " Login failed " };
        }

        return null;
      },
    },
  };

  vm.runInNewContext(script, context, { filename: backgroundPath });

  assert.ok(onMessage.listener, "background should register an onMessage listener");

  const startResult = await sendRuntimeMessage(onMessage.listener, {
    kind: "BEGIN_CAPTURE",
    serverUrl: "http://127.0.0.1:3876",
    suiteName: "demo suite",
    testName: "login-success-dashboard",
    environment: {
      browser: {
        family: "chromium",
        version: "149.0.0.0",
        source: "bootstrap-request",
      },
      tool: "selenium",
    },
  });

  assert.equal(JSON.stringify(startResult), JSON.stringify({
    ok: true,
    browserSessionId: "browser-session-1",
  }));

  const finalizeResult = await sendRuntimeMessage(onMessage.listener, {
    kind: "FINALIZE_CAPTURE",
    reason: "completed",
  });

  assert.equal(JSON.stringify(finalizeResult), JSON.stringify({
    ok: true,
    browserSessionId: "browser-session-1",
    finalized: true,
  }));

  const ingestCall = fetchCalls.find((call) => call.url.endsWith("/ingest"));
  assert.ok(ingestCall, "finalization should POST to /ingest");

  const payload = JSON.parse(ingestCall.options.body);

  assert.deepEqual(payload.endState, {
    finalUrl: "http://127.0.0.1:4010/dashboard",
    title: "Dashboard",
    heading: "Dashboard",
    alertText: "Login failed",
  });
  assert.equal(payload.run.id, undefined);
  assert.equal(payload.run.testName, "login-success-dashboard");
  assert.equal(payload.environment.tool, "selenium");
  assert.ok(createdAlarms.some((alarm) => alarm.name === "wdyt-timeout"));
});
