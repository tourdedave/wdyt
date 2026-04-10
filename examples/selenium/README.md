# Selenium Example

This example launches Chrome with the unpacked WDIT extension and performs a
small Google search flow.

Setup:

```bash
cd examples/selenium
npm install
```

Requirements:

- Google Chrome installed
- ChromeDriver available on your PATH, or Selenium Manager able to resolve it

Run:

```bash
npm test
```

After running the example, inspect flows from the repo root:

```bash
wdit flows
```

This example uses the same control flow as Playwright:

- `POST /runs/start`
- navigate to the returned WDIT bootstrap page
- perform the Google search
- `POST /runs/end`
- wait briefly for background polling to flush the run
