import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { DEFAULT_SERVER_URL } from "../../../dist/shared/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const extensionPath = path.join(repoRoot, "dist", "extension");
const demoBaseUrl = "http://127.0.0.1:4010";
const headless = process.env.HEADLESS === "1";
const demoPassword = "wdyt-demo-2026!";

async function startRun(testName) {
  const response = await fetch(`${DEFAULT_SERVER_URL}/runs/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      suiteName: "examples/demo/playwright",
      testName,
      environment: {
        tool: "playwright",
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

async function login(page, username = "demo", password = demoPassword) {
  await page.goto(`${demoBaseUrl}/login`, { waitUntil: "domcontentloaded" });
  await submitCredentials(page, username, password);
}

async function submitCredentials(page, username = "demo", password = demoPassword) {
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForLoadState("domcontentloaded");
}

async function logout(page) {
  await page.goto(`${demoBaseUrl}/logout`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(`${demoBaseUrl}/login`);
}

async function withBoundPage(context, testName, testFn) {
  const page = context.pages()[0] ?? (await context.newPage());
  const started = await startRun(testName);

  try {
    await page.goto(started.bootstrapUrl, { waitUntil: "domcontentloaded" });
    await page.locator('#status[data-status="ok"]').waitFor({ timeout: 15_000 });
    await testFn(page);
  } finally {
    await endRun(started.runId);
    await page.waitForTimeout(2_500);
  }
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
    await withBoundPage(context, "login-success-dashboard", async (page) => {
      await login(page);
      await page.waitForURL(`${demoBaseUrl}/dashboard`);
    });

    await withBoundPage(context, "login-redirect-dashboard", async (page) => {
      await logout(page);
      await page.goto(`${demoBaseUrl}/dashboard`, { waitUntil: "domcontentloaded" });
      await page.waitForURL(`${demoBaseUrl}/login`);
      await submitCredentials(page);
      await page.waitForURL(`${demoBaseUrl}/dashboard`);
    });

    await withBoundPage(context, "dashboard-link-after-login", async (page) => {
      await login(page);
      await page.getByRole("link", { name: "Dashboard", exact: true }).click();
      await page.waitForURL(`${demoBaseUrl}/dashboard`);
    });

    await withBoundPage(context, "login-success-reports", async (page) => {
      await login(page);
      await page.getByRole("link", { name: "Open reports" }).click();
      await page.waitForURL(`${demoBaseUrl}/reports`);
    });

    await withBoundPage(context, "login-invalid", async (page) => {
      await login(page, "demo", "wrong-password");
      await page.locator('[role="alert"]').waitFor();
    });

    await withBoundPage(context, "search-empty", async (page) => {
      await login(page);
      await page.getByRole("link", { name: "Open search" }).click();
      await page.waitForURL(`${demoBaseUrl}/search`);
      await page.locator('input[name="q"]').fill("empty");
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(/\/search\/empty\?q=empty$/);
    });

    await withBoundPage(context, "search-results", async (page) => {
      await login(page);
      await page.getByRole("link", { name: "Open search" }).click();
      await page.waitForURL(`${demoBaseUrl}/search`);
      await page.locator('input[name="q"]').fill("wdyt");
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(/\/search\/results\?q=wdyt$/);
    });

    await withBoundPage(context, "search-results-repeat", async (page) => {
      await login(page);
      await page.getByRole("link", { name: "Open search" }).click();
      await page.waitForURL(`${demoBaseUrl}/search`);
      await page.locator('input[name="q"]').fill("wdyt");
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(/\/search\/results\?q=wdyt$/);
      await page.getByRole("link", { name: "Back to search" }).click();
      await page.waitForURL(`${demoBaseUrl}/search`);
      await page.locator('input[name="q"]').fill("demo");
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(/\/search\/results\?q=demo$/);
    });

    await withBoundPage(context, "login-success-settings", async (page) => {
      await login(page);
      await page.getByRole("link", { name: "Open settings" }).click();
      await page.waitForURL(`${demoBaseUrl}/settings`);
    });

    await withBoundPage(context, "workspace-tabs", async (page) => {
      await login(page);
      await page.getByRole("link", { name: "Workspace", exact: true }).click();
      await page.waitForURL(`${demoBaseUrl}/workspace`);
      await page.locator('button[data-route="/workspace/activity"]').click();
      await page.waitForURL(`${demoBaseUrl}/workspace/activity`);
      await page.locator('button[data-route="/workspace/details"]').click();
      await page.waitForURL(`${demoBaseUrl}/workspace/details`);
    });

    await withBoundPage(context, "logout-after-login", async (page) => {
      await login(page);
      await page.getByRole("link", { name: "Sign out" }).click();
      await page.waitForURL(`${demoBaseUrl}/login`);
    });
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
