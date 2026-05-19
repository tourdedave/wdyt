import { Builder, By, Key, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import { getChromiumBinary, getExtensionPath, getHeadlessMode } from "../../scripts/browser-runtime-helpers.mjs";

function buildBootstrapUrl(action, reason = "completed") {
  const url = new URL("/bootstrap", "http://127.0.0.1:3876");
  url.searchParams.set("action", action);
  if (action === "finalize") {
    url.searchParams.set("reason", reason);
  }
  return url.toString();
}

async function bootstrapBind(driver, bootstrapUrl) {
  await driver.get(bootstrapUrl);
  await driver.wait(until.elementLocated(By.css('#status[data-status="ok"]')), 15_000);
}

async function main() {
  const chromiumBinary = getChromiumBinary();
  if (!chromiumBinary) {
    throw new Error(
      "The Selenium example requires Chromium or Chrome for Testing. Set CHROMIUM_BINARY to a compatible browser binary."
    );
  }

  const options = new chrome.Options();
  options.setBrowserName("chrome");
  options.setChromeBinaryPath(chromiumBinary);
  // 1. Launch Chromium with the unpacked wdyt extension loaded.
  options.addArguments(`--load-extension=${getExtensionPath(import.meta.url)}`);
  if (getHeadlessMode()) {
    options.addArguments("--headless=new");
  }

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
  // 2. Bind wdyt capture before visiting the target page.
  await bootstrapBind(driver, buildBootstrapUrl("start"));

  try {
    await driver.get("https://www.google.com/ncr");

    const searchBox = await driver.wait(
      until.elementLocated(By.css('textarea[name="q"], input[name="q"]')),
      15_000
    );

    await searchBox.click();
    await searchBox.clear();
    await searchBox.sendKeys("wdyt testing", Key.ENTER);

    await driver.wait(until.urlContains("/search"), 15_000);
    await driver.sleep(2_000);
  } finally {
    // 3. Finalize capture before quitting the browser session.
    await bootstrapBind(driver, buildBootstrapUrl("finalize"));
    await driver.sleep(4_000);
    await driver.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
