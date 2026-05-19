# Selenium Example

This example launches Chromium with the unpacked wdyt extension and performs a
small Google search flow.

Setup:

```bash
cd examples
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
