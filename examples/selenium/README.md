# Selenium Example

This example performs a small Google search flow with wdyt loaded into Chromium or Chrome for Testing as an unpacked extension.

The wdyt-specific pieces are intentionally minimal:

- load wdyt into the browser
- visit `/bootstrap?action=start`
- run a browser flow
- visit `/bootstrap?action=finalize`

Setup:

```bash
cd examples
npm install
```

Requirements:

- Chromium or Chrome for Testing
- ChromeDriver on your PATH, or Selenium Manager able to resolve a compatible driver

On macOS, the example defaults to:

```bash
/Applications/Chromium.app/Contents/MacOS/Chromium
```

Otherwise, or if Selenium is not selecting the browser you want, set:

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

Notes:

- Branded Google Chrome is not a reliable target for extension loading in this automation flow.
- Use Chromium or Chrome for Testing instead. See the Chromium extensions thread:
  https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ
