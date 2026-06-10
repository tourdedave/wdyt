# wdyt

`wdyt` (pronounced "wah-dit") is short for "What did you test?".

It helps you understand what your automated tests actually did.

It captures browser execution evidence from real test runs, interprets the behaviors those tests produced, and helps you compare them against expected flows to determine business coverage.

[![WDYT Demo](https://img.youtube.com/vi/p4wMBUeOThs/maxresdefault.jpg)](https://www.youtube.com/watch?v=p4wMBUeOThs)

## What `wdyt` Is

`wdyt` is:

- a model-agnostic test observability tool
- a trust-building layer for browser tests
- a way to see the business coverage created by your existing suite
- the missing tool for human-in-the-loop QA review

`wdyt` helps answer:

- what did this suite actually do?
- which user behaviors were meaningfully exercised?
- where do we have duplicate coverage?
- which expected behaviors were missing, partial, or covered?

## What You Get

With `wdyt`, you can:

- capture execution evidence from any browser automation test tool
- review observed behaviors in a browser UI
- define expected user behaviors and compare them against observed evidence
- see unique flows and repeated coverage across test runs
- use as a drop in within your current test runs on CI
- export an archive of wdyt data from one or more runs and review later on another machine
- share findings with others through a summary pdf or archive export

## Why Teams Use It

Browser tests are often hard to trust at a business level.

A suite may be green, but it can still be unclear:

- were the right behaviors were exercised?
- are multiple tests covering the same thing?
- are important user flows missing?

`wdyt` makes those questions easily answerable.

It is designed to sit between:

- raw automated execution
- and human judgment about coverage, confidence, and risk

## Model Agnostic

`wdyt` works with an OpenAI-compatible API endpoint.

That means you can point it at the model and provider your environment approves, as long as it supports the OpenAI-style API shape. `wdyt` does not require a single hosted model vendor.

## Standard Workflow

The standard flow is:

1. start the `wdyt` server
2. wire the browser extension into test setup and teardown
3. run tests
4. review observed behaviors and expected-behavior coverage
5. export archives or share results

If tests run locally, review results in the `wdyt` UI right away.

If tests run in CI, export a `wdyt` archive, persist it, then import it later for review.

## Getting Started

Use these docs first:

- [Getting Started](docs/getting-started.md)
- [Bootstrap Metadata](docs/bootstrap-metadata.md)

Use these reference examples for extension wiring:

- [Examples Overview](examples/README.md)
- [Playwright Example](examples/playwright/README.md)
- [Selenium Example](examples/selenium/README.md)

## Reviewing Results

Once test runs have been captured, `wdyt` gives you three main views:

- `Observed Behaviors`
  - what your tests actually exercised
- `Expected Behaviors`
  - where you specify the business-critical behaviors you want to compare against captured evidence
- `Summary`
  - unique flows, repeated coverage, and expected-behavior coverage

This makes `wdyt` useful both as:

- an observability layer for automated test runs
- a review workflow for human-in-the-loop QA that scales
