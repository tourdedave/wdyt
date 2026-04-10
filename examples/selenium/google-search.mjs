import path from "node:path";
import { fileURLToPath } from "node:url";

import { Builder, By, Key, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

import { DEFAULT_SERVER_URL } from "../../dist/shared/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const extensionPath = path.join(repoRoot, "dist", "extension");

async function startRun() {
  const response = await fetch(`${DEFAULT_SERVER_URL}/runs/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      suiteName: "examples/selenium",
      testName: "google search hello world",
      environment: {
        tool: "selenium",
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

async function main() {
  const options = new chrome.Options();
  options.setBrowserName("chrome");
  options.setChromeBinaryPath(process.env.CHROMIUM_BINARY ?? "/Applications/Chromium.app/Contents/MacOS/Chromium");
  options.addArguments(`--disable-extensions-except=${extensionPath}`);
  options.addArguments(`--load-extension=${extensionPath}`);

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  try {
    const started = await startRun();

    await driver.get(started.bootstrapUrl);
    await driver.wait(until.elementLocated(By.css('#status[data-status="ok"]')), 15_000);

    await driver.get("https://www.google.com/ncr");

    const searchBox = await driver.wait(
      until.elementLocated(By.css('textarea[name="q"], input[name="q"]')),
      15_000
    );

    await searchBox.click();
    await searchBox.clear();
    await searchBox.sendKeys("wdit testing", Key.ENTER);

    await driver.wait(until.urlContains("/search"), 15_000);
    await driver.sleep(2_000);

    await endRun(started.runId);
    await driver.sleep(4_000);
  } finally {
    await driver.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
