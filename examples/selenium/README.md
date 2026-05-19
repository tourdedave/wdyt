# Selenium Example

This example launches Chromium with the unpacked wdyt extension and performs a
small Google search flow.

The wdyt-specific pieces are intentionally minimal:

- load the unpacked extension with Chromium launch args
- visit `/bootstrap?action=start`
- run a browser flow
- visit `/bootstrap?action=finalize`

Setup:

```bash
cd examples
npm install
```

Requirements:

- a Chromium-compatible browser
- ChromeDriver on your PATH, or Selenium Manager able to resolve a compatible driver

If Selenium is not selecting the browser you want, set:

```bash
CHROMIUM_BINARY=/path/to/chromium npm run test:selenium
```

Run:

```bash
npm run test:selenium
```

Optional headless mode:

```bash
HEADLESS=1 npm run test:selenium
```

After running the example, inspect flows from the repo root:

```bash
wdyt flows
```

This example uses the same control flow as Playwright:

- navigate to the wdyt bootstrap page with `action=start`
- perform the Google search
- navigate to the wdyt bootstrap page with `action=finalize`
- wait briefly for the extension to flush the run

Note:

- Branded Google Chrome 137+ no longer reliably supports unpacked extension loading via the
  command-line flags used by local automation. Use Chromium or Chrome for Testing for this example.
