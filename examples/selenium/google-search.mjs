import path from "node:path";
import { fileURLToPath } from "node:url";

import { Builder, By, Key, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

import { DEFAULT_SERVER_URL } from "../../dist/shared/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const extensionPath = path.join(repoRoot, "dist", "extension");
const headless = process.env.HEADLESS === "1";

function buildBootstrapUrl(action, reason = "completed") {
  const url = new URL("/bootstrap", DEFAULT_SERVER_URL);
  url.searchParams.set("action", action);
  if (action === "finalize") {
    url.searchParams.set("reason", reason);
  }
  return url.toString();
}

async function main() {
  const options = new chrome.Options();
  options.setBrowserName("chrome");
  if (process.env.CHROMIUM_BINARY) {
    options.setChromeBinaryPath(process.env.CHROMIUM_BINARY);
  }
  options.addArguments(`--disable-extensions-except=${extensionPath}`);
  options.addArguments(`--load-extension=${extensionPath}`);
  if (headless) {
    options.addArguments("--headless=new");
  }

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  try {
    await driver.get(buildBootstrapUrl("start"));
    await driver.wait(until.elementLocated(By.css('#status[data-status="ok"]')), 15_000);

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

    await driver.get(buildBootstrapUrl("finalize"));
    await driver.wait(until.elementLocated(By.css('#status[data-status="ok"]')), 15_000);
    await driver.sleep(4_000);
  } finally {
    await driver.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
