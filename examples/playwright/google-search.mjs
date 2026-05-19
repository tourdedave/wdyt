import { chromium } from "playwright";
import { getExtensionPath, getHeadlessMode } from "../../scripts/browser-runtime-helpers.mjs";

function buildBootstrapUrl(action, reason = "completed") {
  const url = new URL("/bootstrap", "http://127.0.0.1:3876");
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
  // 1. Launch Chromium with the unpacked wdyt extension loaded.
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: getHeadlessMode(),
    args: [`--load-extension=${getExtensionPath(import.meta.url)}`],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    // 2. Bind wdyt capture before visiting the target page.
    await bootstrapBind(page, buildBootstrapUrl("start"));
    await page.goto("https://www.google.com/ncr", { waitUntil: "domcontentloaded" });

    const searchBox = page.locator('textarea[name="q"], input[name="q"]').first();
    await searchBox.waitFor({ state: "visible", timeout: 15_000 });
    await searchBox.click();
    await searchBox.fill("wdyt testing");
    await searchBox.press("Enter");

    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);
  } finally {
    // 3. Finalize capture before closing the browser context.
    await bootstrapBind(page, buildBootstrapUrl("finalize"));
    await page.waitForTimeout(4_000);
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
