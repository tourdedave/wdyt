# WDYT Example Tests

This directory contains end-to-end example tests that exercise WDYT with
different browser automation tools.

Current suites:

- `smoke/playwright/`: Chromium + extension + Google search smoke test
- `smoke/selenium/`: Chromium + extension + Google search smoke test
- `demo/playwright/`: hook-based suite against the controlled demo app
- `demo/selenium/`: hook-based suite against the controlled demo app

Smoke examples are intentionally small and focused on proving the WDYT loop:

1. launch a browser with the built WDYT extension loaded
2. open the WDYT bootstrap page with `action=start` to begin capture for a named suite/test
4. perform a small interaction flow on a real page
5. open the WDYT bootstrap page with `action=finalize`
6. let the extension flush one buffered capture to `/ingest`
7. inspect `wdyt flows` on the server side

Prerequisites:

- run `npm run build` in the repo root so `dist/extension/` exists
- start the WDYT server with `node dist/server/index.js`
- install the dependencies in the specific example directory you want to run

Notes:

- These are smoke tests, not stable production tests.
- Google may present locale-specific consent or anti-bot UI. The examples use
  `https://www.google.com/ncr` to reduce redirects, but some environments may
  still need minor adjustments.

The `demo/` suites are the recommended structure for evaluating reducer quality
and future semantic descriptions against the controlled app in `apps/demo`.
