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
const demoPassword = "wdyt-demo-2026!";
const demoConcurrency = Math.max(1, Math.min(Number.parseInt(process.env.DEMO_CONCURRENCY ?? "10", 10) || 10, 10));

function buildBootstrapUrl(action, testName, reason = "completed") {
  const url = new URL("/bootstrap", DEFAULT_SERVER_URL);
  url.searchParams.set("action", action);
  url.searchParams.set("serverUrl", DEFAULT_SERVER_URL);
  if (action === "start") {
    url.searchParams.set("suiteName", "demo/test/selenium");
    url.searchParams.set("testName", testName);
    url.searchParams.set("tool", "selenium");
  } else {
    url.searchParams.set("reason", reason);
  }
  return url.toString();
}

async function login(driver, username = "demo", password = demoPassword) {
  await driver.get(`${demoBaseUrl}/login`);
  await submitCredentials(driver, username, password);
}

async function submitCredentials(driver, username = "demo", password = demoPassword) {
  const usernameInput = await driver.findElement(By.css('input[name="username"]'));
  const passwordInput = await driver.findElement(By.css('input[name="password"]'));
  const submitButton = await driver.findElement(By.css('button[type="submit"]'));

  await usernameInput.clear();
  await usernameInput.sendKeys(username);
  await passwordInput.clear();
  await passwordInput.sendKeys(password);
  await submitButton.click();

  if (username === "demo" && password === demoPassword) {
    await driver.wait(until.urlIs(`${demoBaseUrl}/dashboard`), 15_000);
  }
}

async function logout(driver) {
  await driver.get(`${demoBaseUrl}/logout`);
  await driver.wait(until.urlIs(`${demoBaseUrl}/login`), 15_000);
}

async function withBoundDriver(driver, testName, testFn) {
  try {
    await driver.get(buildBootstrapUrl("start", testName));
    await driver.wait(until.elementLocated(By.css('#status[data-status="ok"]')), 15_000);
    await testFn();
  } finally {
    await driver.get(buildBootstrapUrl("finalize", testName));
    await driver.wait(until.elementLocated(By.css('#status[data-status="ok"]')), 15_000);
    await driver.sleep(2_500);
  }
}

function buildChromeOptions() {
  const options = new chrome.Options();
  options.setBrowserName("chrome");
  options.setChromeBinaryPath(process.env.CHROMIUM_BINARY ?? "/Applications/Chromium.app/Contents/MacOS/Chromium");
  options.addArguments(`--load-extension=${extensionPath}`);
  if (headless) {
    options.addArguments("--headless=new");
  }
  return options;
}

async function createDriver() {
  return new Builder().forBrowser("chrome").setChromeOptions(buildChromeOptions()).build();
}

const demoTests = [
  {
    name: "login-success-dashboard",
    run: async (driver) => {
      await login(driver);
      await driver.wait(until.urlIs(`${demoBaseUrl}/dashboard`), 15_000);
    },
  },
  {
    name: "login-redirect-dashboard",
    run: async (driver) => {
      await logout(driver);
      await driver.get(`${demoBaseUrl}/dashboard`);
      await driver.wait(until.urlIs(`${demoBaseUrl}/login`), 15_000);
      await submitCredentials(driver);
      await driver.wait(until.urlIs(`${demoBaseUrl}/dashboard`), 15_000);
    },
  },
  {
    name: "dashboard-link-after-login",
    run: async (driver) => {
      await login(driver);
      await driver.findElement(By.linkText("Dashboard")).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/dashboard`), 15_000);
    },
  },
  {
    name: "login-success-reports",
    run: async (driver) => {
      await login(driver);
      await driver.findElement(By.linkText("Open reports")).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/reports`), 15_000);
    },
  },
  {
    name: "login-invalid",
    run: async (driver) => {
      await login(driver, "demo", "wrong-password");
      await driver.wait(until.elementLocated(By.css('[role="alert"]')), 15_000);
    },
  },
  {
    name: "search-empty",
    run: async (driver) => {
      await login(driver);
      await driver.findElement(By.linkText("Open search")).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/search`), 15_000);
      const searchInput = await driver.findElement(By.css('input[name="q"]'));
      await searchInput.clear();
      await searchInput.sendKeys("empty");
      await driver.findElement(By.css('button[type="submit"]')).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/search/empty?q=empty`), 15_000);
    },
  },
  {
    name: "search-results",
    run: async (driver) => {
      await login(driver);
      await driver.findElement(By.linkText("Open search")).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/search`), 15_000);
      const searchInput = await driver.findElement(By.css('input[name="q"]'));
      await searchInput.clear();
      await searchInput.sendKeys("wdyt");
      await driver.findElement(By.css('button[type="submit"]')).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/search/results?q=wdyt`), 15_000);
    },
  },
  {
    name: "search-results-repeat",
    run: async (driver) => {
      await login(driver);
      await driver.findElement(By.linkText("Open search")).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/search`), 15_000);
      const searchInput = await driver.findElement(By.css('input[name="q"]'));
      await searchInput.clear();
      await searchInput.sendKeys("wdyt");
      await driver.findElement(By.css('button[type="submit"]')).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/search/results?q=wdyt`), 15_000);
      await driver.findElement(By.linkText("Back to search")).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/search`), 15_000);
      const repeatedSearchInput = await driver.findElement(By.css('input[name="q"]'));
      await repeatedSearchInput.clear();
      await repeatedSearchInput.sendKeys("demo");
      await driver.findElement(By.css('button[type="submit"]')).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/search/results?q=demo`), 15_000);
    },
  },
  {
    name: "login-success-settings",
    run: async (driver) => {
      await login(driver);
      await driver.findElement(By.linkText("Open settings")).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/settings`), 15_000);
    },
  },
  {
    name: "workspace-tabs",
    run: async (driver) => {
      await login(driver);
      await driver.findElement(By.linkText("Workspace")).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/workspace`), 15_000);
      await driver.findElement(By.css('button[data-route="/workspace/activity"]')).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/workspace/activity`), 15_000);
      await driver.findElement(By.css('button[data-route="/workspace/details"]')).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/workspace/details`), 15_000);
    },
  },
  {
    name: "logout-after-login",
    run: async (driver) => {
      await login(driver);
      await driver.findElement(By.linkText("Sign out")).click();
      await driver.wait(until.urlIs(`${demoBaseUrl}/login`), 15_000);
    },
  },
];

async function runDemoTestsWorker(workerId, queue) {
  const driver = await createDriver();

  try {
    while (true) {
      const next = queue.shift();
      if (!next) {
        return;
      }

      console.log(`[demo-suite] worker=${workerId} test=${next.name}`);
      await withBoundDriver(driver, next.name, async () => {
        await next.run(driver);
      });
    }
  } finally {
    await driver.quit();
  }
}

async function main() {
  const queue = [...demoTests];
  const concurrency = Math.min(demoConcurrency, queue.length);
  console.log(`[demo-suite] starting concurrency=${concurrency} tests=${queue.length}`);

  await Promise.all(
    Array.from({ length: concurrency }, (_, index) => runDemoTestsWorker(index + 1, queue))
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
