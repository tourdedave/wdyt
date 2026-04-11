import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DEMO_PORT ?? "4010");
const HOST = process.env.DEMO_HOST ?? "127.0.0.1";
const SESSION_COOKIE = "wdit_demo_auth=1";
const USERNAME = "demo";
const PASSWORD = "password";

function html(title: string, body: string, extraScripts = "") {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body>
    <main class="shell">
      ${body}
    </main>
    ${extraScripts}
  </body>
</html>`;
}

function nav(current: string) {
  const links = [
    ["/dashboard", "Dashboard"],
    ["/reports", "Reports"],
    ["/settings", "Settings"],
    ["/search", "Search"],
    ["/workspace", "Workspace"],
  ];

  return `<nav class="nav">${links
    .map(([href, label]) => {
      const active = href === current ? ' aria-current="page"' : "";
      return `<a href="${href}"${active}>${label}</a>`;
    })
    .join("")}</nav>`;
}

function card(title: string, content: string) {
  return `<section class="card"><h1>${title}</h1>${content}</section>`;
}

function getCookies(req: IncomingMessage) {
  const raw = req.headers.cookie ?? "";
  return Object.fromEntries(
    raw
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [key, ...rest] = part.split("=");
        return [key, rest.join("=")];
      })
  );
}

function isAuthenticated(req: IncomingMessage) {
  return getCookies(req)["wdit_demo_auth"] === "1";
}

function parseForm(body: string) {
  return Object.fromEntries(new URLSearchParams(body).entries());
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}) {
  res.writeHead(302, {
    location,
    ...headers,
  });
  res.end();
}

function sendHtml(res: ServerResponse, content: string) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(content);
}

async function sendAsset(res: ServerResponse, filename: string, contentType: string) {
  const filePath = path.join(__dirname, "static", filename);
  const content = await readFile(filePath, "utf8");
  res.writeHead(200, { "content-type": contentType });
  res.end(content);
}

function loginPage(errorMessage = "") {
  return html(
    "Demo Login",
    card(
      "Sign in",
      `
        <p>Use <code>${USERNAME}</code> / <code>${PASSWORD}</code>.</p>
        ${
          errorMessage
            ? `<p class="error" role="alert">${errorMessage}</p>`
            : `<p class="hint">Enter valid credentials to open protected pages.</p>`
        }
        <form action="/login" method="post" class="form">
          <label>
            <span>Username</span>
            <input name="username" autocomplete="username" />
          </label>
          <label>
            <span>Password</span>
            <input name="password" type="password" autocomplete="current-password" />
          </label>
          <button type="submit">Sign in</button>
        </form>
      `
    )
  );
}

function protectedPage(route: string, title: string, description: string) {
  return html(
    title,
    `
      ${nav(route)}
      ${card(
        title,
        `
          <p>${description}</p>
          <div class="actions">
            <a class="button" href="/reports">Open reports</a>
            <a class="button" href="/settings">Open settings</a>
            <a class="button" href="/search">Open search</a>
            <a class="button secondary" href="/logout">Sign out</a>
          </div>
        `
      )}
    `
  );
}

function searchPage(query = "") {
  return html(
    "Search",
    `
      ${nav("/search")}
      ${card(
        "Search",
        `
          <p>Search for anything. Query <code>empty</code> shows the empty-state branch.</p>
          <form action="/search" method="get" class="form">
            <label>
              <span>Search query</span>
              <input name="q" value="${query}" />
            </label>
            <button type="submit">Search</button>
          </form>
        `
      )}
    `
  );
}

function searchResultsPage(query: string, empty: boolean) {
  const title = empty ? "No Results" : "Search Results";
  const message = empty
    ? `No results found for "${query}".`
    : `Showing results for "${query}".`;

  return html(
    title,
    `
      ${nav("/search")}
      ${card(
        title,
        `
          <p>${message}</p>
          <div class="actions">
            <a class="button" href="/search">Back to search</a>
            <a class="button secondary" href="/dashboard">Back to dashboard</a>
          </div>
        `
      )}
    `
  );
}

function workspacePage() {
  return html(
    "Workspace",
    `
      ${nav("/workspace")}
      ${card(
        "Workspace",
        `
          <p>This section uses client-side route changes with <code>history.pushState</code>.</p>
          <div class="tab-row">
            <button type="button" data-route="/workspace/overview">Overview</button>
            <button type="button" data-route="/workspace/activity">Activity</button>
            <button type="button" data-route="/workspace/details">Details</button>
          </div>
          <div class="workspace-panel" id="workspace-panel"></div>
        `
      )}
    `,
    `<script type="module" src="/workspace.js"></script>`
  );
}

function requireAuth(req: IncomingMessage, res: ServerResponse) {
  if (!isAuthenticated(req)) {
    redirect(res, "/login");
    return false;
  }

  return true;
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
  const pathname = requestUrl.pathname;

  if (method === "GET" && pathname === "/app.css") {
    await sendAsset(res, "app.css", "text/css; charset=utf-8");
    return;
  }

  if (method === "GET" && pathname === "/workspace.js") {
    await sendAsset(res, "workspace.js", "text/javascript; charset=utf-8");
    return;
  }

  if (method === "GET" && pathname === "/") {
    redirect(res, "/login");
    return;
  }

  if (method === "GET" && pathname === "/login") {
    sendHtml(res, loginPage());
    return;
  }

  if (method === "POST" && pathname === "/login") {
    const body = parseForm(await readBody(req));

    if (body.username === USERNAME && body.password === PASSWORD) {
      redirect(res, "/dashboard", {
        "set-cookie": `${SESSION_COOKIE}; Path=/; HttpOnly; SameSite=Lax`,
      });
      return;
    }

    sendHtml(res, loginPage("Invalid username or password."));
    return;
  }

  if (method === "GET" && pathname === "/logout") {
    redirect(res, "/login", {
      "set-cookie": "wdit_demo_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
    });
    return;
  }

  if (method === "GET" && pathname === "/dashboard") {
    if (!requireAuth(req, res)) return;
    sendHtml(res, protectedPage("/dashboard", "Dashboard", "This is the default protected landing page."));
    return;
  }

  if (method === "GET" && pathname === "/reports") {
    if (!requireAuth(req, res)) return;
    sendHtml(res, protectedPage("/reports", "Reports", "Reports is a second protected branch after login."));
    return;
  }

  if (method === "GET" && pathname === "/settings") {
    if (!requireAuth(req, res)) return;
    sendHtml(res, protectedPage("/settings", "Settings", "Settings is a third protected branch after login."));
    return;
  }

  if (method === "GET" && pathname === "/search") {
    if (!requireAuth(req, res)) return;
    const query = requestUrl.searchParams.get("q") ?? "";

    if (query.length === 0) {
      sendHtml(res, searchPage());
      return;
    }

    if (query === "empty") {
      redirect(res, `/search/empty?q=${encodeURIComponent(query)}`);
      return;
    }

    redirect(res, `/search/results?q=${encodeURIComponent(query)}`);
    return;
  }

  if (method === "GET" && pathname === "/search/results") {
    if (!requireAuth(req, res)) return;
    const query = requestUrl.searchParams.get("q") ?? "";
    sendHtml(res, searchResultsPage(query, false));
    return;
  }

  if (method === "GET" && pathname === "/search/empty") {
    if (!requireAuth(req, res)) return;
    const query = requestUrl.searchParams.get("q") ?? "";
    sendHtml(res, searchResultsPage(query, true));
    return;
  }

  if (method === "GET" && pathname === "/workspace") {
    if (!requireAuth(req, res)) return;
    sendHtml(res, workspacePage());
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`WDIT demo app listening on http://${HOST}:${PORT}`);
});
