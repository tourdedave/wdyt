import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { DEFAULT_SERVER_URL } from "../../../dist/shared/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const extensionPath = path.join(repoRoot, "dist", "extension");
const headless = process.env.HEADLESS === "1";

async function startRun() {
  const response = await fetch(`${DEFAULT_SERVER_URL}/runs/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      suiteName: "examples/smoke/playwright",
      testName: "google search hello world",
      environment: {
        tool: "playwright",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Start run failed with status ${response.status}`);
  }

  return response.json();
}

async function endRun(runId) {
  const response = await fetch(`${DEFAULT_SERVER_URL}/runs/end`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      runId,
      reason: "completed",
    }),
  });

  if (!response.ok) {
    throw new Error(`End run failed with status ${response.status}`);
  }
}

async function bootstrapBind(page, bootstrapUrl) {
  await page.goto(bootstrapUrl, { waitUntil: "domcontentloaded" });
  await page.locator('#status[data-status="ok"]').waitFor({ timeout: 15_000 });
}

async function main() {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const started = await startRun();

    await bootstrapBind(page, started.bootstrapUrl);
    await page.goto("https://www.google.com/ncr", { waitUntil: "domcontentloaded" });

    const searchBox = page.locator('textarea[name="q"], input[name="q"]').first();
    await searchBox.waitFor({ state: "visible", timeout: 15_000 });
    await searchBox.click();
    await searchBox.fill("wdyt testing");
    await searchBox.press("Enter");

    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);

    await endRun(started.runId);
    await page.waitForTimeout(4_000);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
