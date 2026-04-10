# Playwright Example

This example launches Chromium with the unpacked WDIT extension and performs a
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

Expected WDIT behavior:

- `window.startTest(...)` begins a buffered run
- page navigation and user interactions are captured by the extension
- `window.endTest()` sends one POST to `/ingest`

After running the example, inspect flows from the repo root:

```bash
wdit flows
```
