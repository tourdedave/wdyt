# WDIT Example Tests

This directory contains end-to-end example tests that exercise WDIT with
different browser automation tools.

Current suites:

- `smoke/playwright/`: Chromium + extension + Google search smoke test
- `smoke/selenium/`: Chromium + extension + Google search smoke test
- `demo/playwright/`: hook-based suite against the controlled demo app
- `demo/selenium/`: hook-based suite against the controlled demo app

Smoke examples are intentionally small and focused on proving the WDIT loop:

1. launch a browser with the built WDIT extension loaded
2. call `POST /runs/start`
3. open the WDIT extension bootstrap page returned by the server to bind the browser to that run
4. perform a small interaction flow on a real page
5. call `POST /runs/end`
6. let the extension background poll for the ending state and flush the buffered run
7. inspect `wdit flows` on the server side

Prerequisites:

- run `npm run build` in the repo root so `dist/extension/` exists
- start the WDIT server with `node dist/server/index.js`
- install the dependencies in the specific example directory you want to run

Notes:

- These are smoke tests, not stable production tests.
- Google may present locale-specific consent or anti-bot UI. The examples use
  `https://www.google.com/ncr` to reduce redirects, but some environments may
  still need minor adjustments.

The `demo/` suites are the recommended structure for evaluating reducer quality
and future semantic descriptions against the controlled app in `apps/demo`.
