# Getting Started

This guide covers the standard first-use path for `wdyt`:

1. download a release
2. install the `wdyt` package
3. start the `wdyt` server
4. wire the browser extension into test setup/teardown
5. run tests
6. review results locally or export/import archives
7. define expected user flows
8. review summary coverage and duplication signals
9. share results with print/PDF or archive export

## 1. Download A Release

Download the latest `wdyt` release from the GitHub releases page.

The release is expected to include:

- the `wdyt` npm package
- the browser extension bundle

Over time, the package may also be published directly to npm, but the operating model is the same.

## 2. Install The Package

Install `wdyt` in the environment where you want to run the server and review data.

If using a release tarball, install from that artifact. If using a published package later, install from npm.

If you install `wdyt` globally, for example with `npm i -g`, you can invoke `wdyt` directly from your shell.

If you install it into a local npm project instead, run the same commands in this guide with an `npx` prefix, for example:

```bash
npx wdyt server start
```

After install, the main entry point is:

```bash
wdyt server start
```

## 3. Start The `wdyt` Server

`wdyt` needs:

- an OpenAI-compatible API endpoint
- an access token
- a model name

The current environment variables are:

```bash
WDYT_LLM_BASE_URL
WDYT_LLM_API_KEY
WDYT_LLM_MODEL
```

Example:

```bash
WDYT_LLM_BASE_URL=https://your-llm-endpoint.example.com/v1 \
WDYT_LLM_API_KEY=your-token \
WDYT_LLM_MODEL=your-model \
wdyt server start
```

Optional server overrides:

```bash
WDYT_HOST      # default: 127.0.0.1
WDYT_PORT      # default: 3876
WDYT_DATA_DIR  # default: .wdyt under the current working directory
WDYT_LLM_CONCURRENCY  # default: 10 concurrent LLM requests
```

`WDYT_LLM_CONCURRENCY` controls how many enrichment requests `wdyt` will run in parallel.

Default local address:

```text
http://127.0.0.1:3876
```

### Running In CI

If `wdyt` is running on the same CI node as the test runner, the best current model is:

1. start `wdyt` as a background process
2. run tests
3. export an archive
4. stop `wdyt`

That keeps the test runner in control while letting `wdyt` ingest and enrich in parallel.

Example on Unix/Linux:

```bash
WDYT_LLM_BASE_URL=https://your-llm-endpoint.example.com/v1 \
WDYT_LLM_API_KEY=your-token \
WDYT_LLM_MODEL=your-model \
wdyt server start > wdyt.log 2>&1 &

WDYT_PID=$!

# run your test suite here

wdyt artifact export --output ./artifacts/wdyt-run.zip --wait-for-enrichment

kill "$WDYT_PID"
```

If you want to cap how long export waits for in-flight enrichment, you can also set:

```bash
wdyt artifact export --output ./artifacts/wdyt-run.zip --wait-for-enrichment --wait-timeout-ms 300000
```

If your CI runner already has a reasonable job timeout, you may not need to set `--wait-timeout-ms` explicitly.

## 4. Wire The Extension Into Test Setup/Teardown

Use the reference examples first:

- [examples/playwright](../examples/playwright)
- [examples/selenium](../examples/selenium)

The standard capture loop is:

1. launch the browser with the `wdyt` extension loaded
2. visit `/bootstrap?action=start`
3. wait for `#status[data-status="ok"]`
4. run the browser flow
5. visit `/bootstrap?action=finalize`
6. wait for `#status[data-status="ok"]`
7. clean up the browser session

The smallest supported bootstrap handshake is:

```text
/bootstrap?action=start
/bootstrap?action=finalize
```

Additional optional metadata is documented here:

- [bootstrap-metadata.md](/Users/dp/dev/wdyt/docs/bootstrap-metadata.md)

## 5. Run Tests

Once the extension is wired into your test setup and teardown, run tests normally.

During execution:

- the extension captures browser events
- `wdyt` ingests each finalized run
- enrichment proposals are generated in the background

## 6. Review Results

There are two main paths.

### 6a. Same Machine: Review Immediately

If test execution and review happen on the same machine, open the `wdyt` UI:

- `http://127.0.0.1:3876/review`
- `http://127.0.0.1:3876/expected-behaviors`
- `http://127.0.0.1:3876/review/summary`

CLI inspection is also available:

```bash
wdyt flows
```

### 6b. CI Or Remote Execution: Export And Review Later

If tests run in CI:

1. export a `wdyt` archive after the run
2. persist that archive as a build artifact
3. download one or more archives later for review

Export:

```bash
wdyt artifact export
```

If you want export to wait for pending enrichment first:

```bash
wdyt artifact export --wait-for-enrichment
```

If you want to control the output path:

```bash
wdyt artifact export --output ./artifacts/wdyt-run.zip
```

Import a single archive:

```bash
wdyt artifact import ./artifacts/wdyt-run.zip
```

Import and merge multiple archives:

```bash
wdyt artifact import ./artifacts/run-a.zip ./artifacts/run-b.zip
```

Archives can also be loaded through the UI.

## 7. Define Expected User Flows

In the `Expected Behaviors` page, specify the behaviors your application is expected to support.

This is where you define:

- business-critical user flows
- expected actions and qualifiers
- the behaviors you want to compare against captured evidence

## 8. Review Summary Coverage

Use `Summary` to review:

- unique flows across all captured tests
- repeated coverage that may indicate duplicated tests
- coverage against expected behaviors

The intended reading is:

- what was meaningfully exercised
- what appears duplicated or repeated
- what expected behavior is covered, partial, or missing

## 9. Share Results

Two main sharing paths are available:

### Print / Save as PDF

From the `Summary` page:

- use `Export`
- choose `Print / Save as PDF`

This uses the browser’s print flow.

### Export The Archive

From the `Summary` page:

- use `Export`
- choose `Download artifact (.zip)`

Or use the CLI:

```bash
wdyt artifact export
```

Archive export is the right option when someone else needs to load the full dataset back into `wdyt` for further review.

## Notes

- Start with the minimal bootstrap handshake first, then add more metadata once the core loop is working.
- For Selenium, use Chromium or Chrome for Testing rather than branded Google Chrome for extension loading in automation.
- If enrichment is still running when you export, the archive may include pending review units unless you use `--wait-for-enrichment`.
- The examples are the reference implementation for extension wiring. Use them before introducing framework-specific abstraction.
