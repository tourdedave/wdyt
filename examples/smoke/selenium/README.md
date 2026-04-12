# Selenium Example

This example launches Chromium with the unpacked WDYT extension and performs a
small Google search flow.

Setup:

```bash
cd examples/selenium
npm install
```

Requirements:

- Chromium installed locally
- ChromeDriver available on your PATH, or Selenium Manager able to resolve a compatible driver

On macOS, the simplest setup is:

```bash
brew install --cask chromium
```

If macOS blocks Chromium with a message like `"Chromium" is damaged and can't be opened`,
remove the quarantine attribute and launch it once manually:

```bash
xattr -dr com.apple.quarantine /Applications/Chromium.app
open -a /Applications/Chromium.app
```

Run:

```bash
npm test
```

Optional headless mode:

```bash
HEADLESS=1 npm test
```

After running the example, inspect flows from the repo root:

```bash
wdyt flows
```

This example uses the same control flow as Playwright:

- `POST /runs/start`
- navigate to the returned WDYT bootstrap page
- perform the Google search
- `POST /runs/end`
- wait briefly for background polling to flush the run

Note:

- Branded Google Chrome 137+ no longer reliably supports unpacked extension loading via the
  command-line flags used by local automation. Use Chromium or Chrome for Testing for this example.
