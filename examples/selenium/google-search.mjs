import { Builder, By, Key, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

import { getExtensionPath } from "../../scripts/browser-runtime-helpers.mjs";

const extensionPath = getExtensionPath(import.meta.url);
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

async function bootstrapBind(driver, bootstrapUrl) {
  await driver.get(bootstrapUrl);
  await driver.wait(until.elementLocated(By.css('#status[data-status="ok"]')), 15_000);
}

async function main() {
  const options = new chrome.Options();
  options.setBrowserName("chrome");
  if (process.env.CHROMIUM_BINARY) {
    options.setChromeBinaryPath(process.env.CHROMIUM_BINARY);
  }
  options.addArguments(`--load-extension=${extensionPath}`);
  if (headless) {
    options.addArguments("--headless=new");
  }

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  try {
    await bootstrapBind(driver, buildBootstrapUrl("start"));

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

    await bootstrapBind(driver, buildBootstrapUrl("finalize"));
    await driver.sleep(4_000);
  } finally {
    await driver.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
