# wdyt demo

This directory contains the controlled demo target and the reference test
suites that exercise it.

Layout:

- `app/`: the demo web app
- `test/playwright/`: Playwright reference suite against the demo app
- `test/selenium/`: Selenium reference suite against the demo app

Setup:

```bash
cd demo
npm install
```

Run the demo app:

```bash
npm run app:build
npm run app:start
```

Run the reference suites:

```bash
npm run test:playwright
npm run test:selenium
```

Optional headless mode:

```bash
HEADLESS=1 npm run test:playwright
HEADLESS=1 npm run test:selenium
```

Optional Selenium parallelism:

```bash
DEMO_CONCURRENCY=10 npm run test:selenium
```

Default URL:

```text
http://127.0.0.1:4010
```

Demo credentials:

- username: `demo`
- password: `wdyt-demo-2026!`
