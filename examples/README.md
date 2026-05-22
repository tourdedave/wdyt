# wdyt examples

This directory contains framework-level reference implementations for wdyt.

Current references:

- `playwright/`: Chromium + extension + Google search flow
- `selenium/`: Chromium + extension + Google search flow

These examples are intentionally small and focused on proving the wdyt loop:

1. launch a browser with the built wdyt extension loaded
2. open the wdyt bootstrap page with `action=start` to begin capture
3. perform a small interaction flow on a real page
4. open the wdyt bootstrap page with `action=finalize`
5. let the extension flush one buffered capture to `/ingest`
6. inspect `wdyt flows` on the server side

Setup:

```bash
cd examples
npm install
```

Run:

```bash
npm run test:playwright
npm run test:selenium
```

Prerequisites:

- run `npm run build` in the repo root so `dist/extension/` exists
- start the wdyt server with `node dist/server/index.js`
- or set `WDYT_EXTENSION_PATH=/path/to/unpacked/extension` to use a different extension build

Notes:

- Google may present locale-specific consent or anti-bot UI. The examples use
  `https://www.google.com/ncr` to reduce redirects, but some environments may
  still need minor adjustments.
- The examples intentionally keep bootstrap metadata minimal. Only `action` is
  required for the capture handoff shown here.
- For the controlled app and richer reference suites, use `demo/`.
