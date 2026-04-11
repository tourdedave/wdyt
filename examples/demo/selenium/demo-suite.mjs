import path from "node:path";
import { fileURLToPath } from "node:url";

import { Builder, By, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

import { DEFAULT_SERVER_URL } from "../../../dist/shared/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const extensionPath = path.join(repoRoot, "dist", "extension");
const demoBaseUrl = "http://127.0.0.1:4010";
const headless = process.env.HEADLESS === "1";

async function startRun(testName) {
  const response = await fetch(`${DEFAULT_SERVER_URL}/runs/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      suiteName: "examples/demo/selenium",
      testName,
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

async function login(driver, username = "demo", password = "password") {
  await driver.get(`${demoBaseUrl}/login`);
  const usernameInput = await driver.findElement(By.css('input[name="username"]'));
  const passwordInput = await driver.findElement(By.css('input[name="password"]'));
  const submitButton = await driver.findElement(By.css('button[type="submit"]'));

  await usernameInput.clear();
  await usernameInput.sendKeys(username);
  await passwordInput.clear();
  await passwordInput.sendKeys(password);
  await submitButton.click();
}

async function withBoundDriver(driver, testName, testFn) {
  const started = await startRun(testName);

  try {
    await driver.get(started.bootstrapUrl);
    await driver.wait(until.elementLocated(By.css('#status[data-status="ok"]')), 15_000);
    await testFn();
  } finally {
    await endRun(started.runId);
    await driver.sleep(2_500);
  }
}

async function main() {
  const options = new chrome.Options();
  options.setBrowserName("chrome");
  options.setChromeBinaryPath(process.env.CHROMIUM_BINARY ?? "/Applications/Chromium.app/Contents/MacOS/Chromium");
  options.addArguments(`--disable-extensions-except=${extensionPath}`);
  options.addArguments(`--load-extension=${extensionPath}`);
  if (headless) {
    options.addArguments("--headless=new");
  }

  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

  try {
    await withBoundDriver(driver, "login-success-dashboard", async () => {
      await login(driver);
      await driver.wait(until.urlIs(`${demoBaseUrl}/dashboard`), 15_000);
    });

    await withBoundDriver(driver, "login-success-reports", async () => {
      await login(driver);
      await driver.findElement(By.css('a[href="/reports"]')).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/reports`), 15_000);
    });

    await withBoundDriver(driver, "login-invalid", async () => {
      await login(driver, "demo", "wrong-password");
      await driver.wait(until.elementLocated(By.css('[role="alert"]')), 15_000);
    });

    await withBoundDriver(driver, "search-empty", async () => {
      await login(driver);
      await driver.findElement(By.css('a[href="/search"]')).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/search`), 15_000);
      const searchInput = await driver.findElement(By.css('input[name="q"]'));
      await searchInput.clear();
      await searchInput.sendKeys("empty");
      await driver.findElement(By.css('button[type="submit"]')).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/search/empty?q=empty`), 15_000);
    });

    await withBoundDriver(driver, "workspace-tabs", async () => {
      await login(driver);
      await driver.findElement(By.css('a[href="/workspace"]')).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/workspace`), 15_000);
      await driver.findElement(By.css('button[data-route="/workspace/activity"]')).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/workspace/activity`), 15_000);
      await driver.findElement(By.css('button[data-route="/workspace/details"]')).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/workspace/details`), 15_000);
    });
  } finally {
    await driver.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
