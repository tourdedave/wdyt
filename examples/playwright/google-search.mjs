import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const extensionPath = path.join(repoRoot, "dist", "extension");

async function main() {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    await page.goto("https://www.google.com/ncr", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.startTest === "function");

    await page.evaluate(() => {
      window.startTest?.({
        suite: "examples/playwright",
        testName: "google search hello world",
      });
    });

    const searchBox = page.locator('textarea[name="q"], input[name="q"]').first();
    await searchBox.waitFor({ state: "visible", timeout: 15_000 });
    await searchBox.click();
    await searchBox.fill("wdit testing");
    await searchBox.press("Enter");

    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);

    await page.evaluate(() => {
      window.endTest?.();
    });

    await page.waitForTimeout(2_000);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
