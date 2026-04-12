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

- `POST /runs/start` creates a run and returns a bootstrap URL
- the bootstrap page binds this browser instance to that run
- page navigation and user interactions are captured by the extension
- `POST /runs/end` marks the run for completion
- background polling notices the ending state and flushes one POST to `/ingest`

After running the example, inspect flows from the repo root:

```bash
wdyt flows
```
