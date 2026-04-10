# WDIT Example Tests

This directory contains end-to-end example tests that exercise WDIT with
different browser automation tools.

Current examples:

- `playwright/`: Chromium + extension + Google search smoke test
- `selenium/`: Chrome + extension + Google search smoke test

Each example is intentionally small and focused on proving the WDIT loop:

1. launch a browser with the built WDIT extension loaded
2. navigate to a real page
3. call `window.startTest({ suite, testName })`
4. perform a small interaction flow
5. call `window.endTest()`
6. inspect `wdit flows` on the server side

Prerequisites:

- run `npm run build` in the repo root so `dist/extension/` exists
- start the WDIT server with `node dist/server/index.js`
- install the dependencies in the specific example directory you want to run

Notes:

- These are smoke tests, not stable production tests.
- Google may present locale-specific consent or anti-bot UI. The examples use
  `https://www.google.com/ncr` to reduce redirects, but some environments may
  still need minor adjustments.
