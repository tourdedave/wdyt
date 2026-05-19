import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { DEFAULT_SERVER_URL } from "../../dist/shared/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const extensionPath = path.join(repoRoot, "dist", "extension");
const headless = process.env.HEADLESS === "1";

function buildBootstrapUrl(action, reason = "completed") {
  const url = new URL("/bootstrap", DEFAULT_SERVER_URL);
  url.searchParams.set("action", action);
  url.searchParams.set("serverUrl", DEFAULT_SERVER_URL);
  if (action === "start") {
    url.searchParams.set("suiteName", "examples/playwright");
    url.searchParams.set("testName", "google search hello world");
    url.searchParams.set("tool", "playwright");
  } else {
    url.searchParams.set("reason", reason);
  }
  return url.toString();
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
    await bootstrapBind(page, buildBootstrapUrl("start"));
    await page.goto("https://www.google.com/ncr", { waitUntil: "domcontentloaded" });

    const searchBox = page.locator('textarea[name="q"], input[name="q"]').first();
    await searchBox.waitFor({ state: "visible", timeout: 15_000 });
    await searchBox.click();
    await searchBox.fill("wdyt testing");
    await searchBox.press("Enter");

    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);

    await bootstrapBind(page, buildBootstrapUrl("finalize"));
    await page.waitForTimeout(4_000);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
