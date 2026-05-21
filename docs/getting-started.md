# Getting Started

This guide covers the smallest end-to-end path for wiring `wdyt` into a browser-based test and then reviewing the captured results.

It is written around the current extension-based capture model:

1. build the extension
2. start the `wdyt` server
3. launch the browser with the built extension loaded
4. visit the bootstrap page with `action=start`
5. run a test flow
6. visit the bootstrap page with `action=finalize`
7. review results in the UI or through the CLI

## Reference Examples

Use these first before building your own harness integration:

- [examples/README.md](/Users/dp/dev/wdyt/examples/README.md)
- [examples/playwright/README.md](/Users/dp/dev/wdyt/examples/playwright/README.md)
- [examples/selenium/README.md](/Users/dp/dev/wdyt/examples/selenium/README.md)

The examples intentionally keep the `wdyt`-specific setup minimal and show the expected capture lifecycle clearly.

## 1. Build And Start

```bash
npm install
npm run build
node dist/server/index.js
```

By default the server runs on:

```text
http://127.0.0.1:3876
```

## 2. Load The Extension

Your test browser needs the built extension from:

```text
dist/extension/
```

The reference examples show the current supported pattern:

- Playwright: launch persistent Chromium with `--load-extension=...`
- Selenium: launch Chromium or Chrome for Testing with `--load-extension=...`

For Selenium, use Chromium or Chrome for Testing, not branded Google Chrome. See:

- https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ

## 3. Bind Capture At Test Start

At the beginning of a test session, visit:

```text
http://127.0.0.1:3876/bootstrap?action=start
```

Wait for the bootstrap page to reach:

```text
#status[data-status="ok"]
```

That wait matters. A page load alone is not enough; the `ok` state confirms that the extension bridge responded and capture has started.

## 4. Run The Test Flow

After the start bootstrap call succeeds, run the browser flow you want `wdyt` to observe.

The extension captures:

- navigation
- click
- input
- change
- submit

It also snapshots the final visible end state used later for interpretation.

## 5. Finalize Capture Before Cleanup

Just before browser/session cleanup, visit:

```text
http://127.0.0.1:3876/bootstrap?action=finalize
```

Again, wait for:

```text
#status[data-status="ok"]
```

This signals the extension to finalize capture and flush the run to:

```text
/ingest
```

## Bootstrap Parameters

Current bootstrap query parameters:

- required:
  - `action`
    - `start`
    - `finalize`
- optional:
  - `serverUrl`
  - `suiteName`
  - `testName`
  - `tool`
  - `reason`
    - only relevant for `finalize`
    - `completed`
    - `timeout`

Examples:

```text
http://127.0.0.1:3876/bootstrap?action=start
```

```text
http://127.0.0.1:3876/bootstrap?action=start&suiteName=checkout&testName=guest-checkout&tool=playwright
```

```text
http://127.0.0.1:3876/bootstrap?action=finalize&reason=timeout
```

### Defaults And Inference

If optional metadata is omitted:

- `serverUrl`
  - defaults to the bootstrap request origin
- `suiteName`
  - defaults internally to `unknown-suite`
- `testName`
  - defaults internally to `unnamed-test`
- browser metadata
  - is inferred from the bootstrap request by the server when possible

This means the minimal supported handshake is:

```text
/bootstrap?action=start
/bootstrap?action=finalize
```

## Standard Usage Loop

Once runs have been captured, the normal `wdyt` loop is:

1. run tests with the extension loaded
2. let `wdyt` ingest and enrich runs
3. inspect observed behaviors
4. define expected behaviors
5. review summary coverage

### Review In The UI

Open:

- [Observed Behaviors](http://127.0.0.1:3876/review)
- [Expected Behaviors](http://127.0.0.1:3876/expected-behaviors)
- [Summary](http://127.0.0.1:3876/review/summary)

What each page is for:

- `Observed Behaviors`
  - execution-level review units
  - repeated coverage
  - evidence inspection
- `Expected Behaviors`
  - define expected business behaviors
  - compare them against observed evidence
- `Summary`
  - aggregate structural behavior coverage
  - drill into filtered observed results

### Review Through The CLI

Useful CLI entry points:

```bash
wdyt flows
```

This prints the current captured/reduced flows from the runtime data directory.

If you want to export the current runtime state:

```bash
wdyt artifact export
```

If you want export to wait for pending enrichment first:

```bash
wdyt artifact export --wait-for-enrichment
```

## Exporting Artifacts

`wdyt` can package the current runtime state into a ZIP artifact. This is useful for:

- sharing captured results with someone else
- moving analysis from CI to a local machine
- preserving a point-in-time snapshot of runs, review units, and expected behaviors

### CLI Export

```bash
wdyt artifact export
```

This writes a ZIP artifact from the current `.wdyt/` runtime state.

If you want to control the output path:

```bash
wdyt artifact export --output ./artifacts/wdyt-run.zip
```

If you want to wait for in-flight enrichment first:

```bash
wdyt artifact export --wait-for-enrichment
```

You can also combine both:

```bash
wdyt artifact export --output ./artifacts/wdyt-run.zip --wait-for-enrichment
```

### UI Export

From the Summary page:

- use `Export`
- choose `Download artifact (.zip)`

### Importing Artifacts

To restore an artifact locally:

```bash
wdyt artifact import ./artifacts/wdyt-run.zip
```

You can also merge multiple artifacts:

```bash
wdyt artifact import ./artifacts/run-a.zip ./artifacts/run-b.zip
```

After import:

- start the `wdyt` server
- open the UI
- inspect observed behaviors, expected behaviors, and summary coverage against the imported data

## Common Integration Shape

The examples all follow this structure:

```js
// 1. Launch browser with the built wdyt extension loaded.
// 2. Visit /bootstrap?action=start and wait for #status[data-status="ok"].
// 3. Run the browser flow.
// 4. Visit /bootstrap?action=finalize and wait for #status[data-status="ok"].
// 5. Close the browser/session.
```

That is the expected reference pattern for new framework integrations.

## Notes

- Keep the initial integration minimal first. Start with just `action=start` and `action=finalize`.
- Add `suiteName`, `testName`, and `tool` once the base capture loop is working.
- If enrichment is still running when you export, the artifact may contain pending review units unless you opt into `--wait-for-enrichment`.
- For the controlled app and richer demo suites, use [`demo/`](/Users/dp/dev/wdyt/demo).
