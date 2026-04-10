import path from "node:path";
import { fileURLToPath } from "node:url";

import { Builder, By, Key, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const extensionPath = path.join(repoRoot, "dist", "extension");

async function main() {
  const options = new chrome.Options();
  options.addArguments(`--load-extension=${extensionPath}`);

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  try {
    await driver.get("https://www.google.com/ncr");
    await driver.wait(async () => {
      return driver.executeScript("return typeof window.startTest === 'function'");
    }, 15_000);

    await driver.executeScript(`
      window.startTest({
        suite: "examples/selenium",
        testName: "google search hello world"
      });
    `);

    const searchBox = await driver.wait(
      until.elementLocated(By.css('textarea[name="q"], input[name="q"]')),
      15_000
    );

    await searchBox.click();
    await searchBox.clear();
    await searchBox.sendKeys("wdit testing", Key.ENTER);

    await driver.wait(until.urlContains("/search"), 15_000);
    await driver.sleep(2_000);

    await driver.executeScript("window.endTest()");
    await driver.sleep(2_000);
  } finally {
    await driver.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
