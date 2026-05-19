import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const extensionPath = path.join(repoRoot, "dist", "extension");
const headless = process.env.HEADLESS === "1";
const serverUrl = "http://127.0.0.1:3876";

function buildBootstrapUrl(action, reason = "completed") {
  const url = new URL("/bootstrap", serverUrl);
  url.searchParams.set("action", action);
  if (action === "finalize") {
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
