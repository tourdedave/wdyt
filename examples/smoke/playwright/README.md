# Playwright Example

This example launches Chromium with the unpacked WDYT extension and performs a
small Google search flow.

Setup:

```bash
cd examples/playwright
npm install
```

Run:

```bash
npm test
```

Optional headless mode:

```bash
HEADLESS=1 npm test
```

Expected WDYT behavior:

- the bootstrap page is opened with `action=start` to begin capture
- page navigation and user interactions are captured by the extension
- the bootstrap page is opened again with `action=finalize`
- the extension flushes one POST to `/ingest`

After running the example, inspect flows from the repo root:

```bash
wdyt flows
```
