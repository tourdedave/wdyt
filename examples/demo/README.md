# WDIT Demo Suites

These examples target the controlled demo app in `apps/demo` and represent the
recommended WDIT integration style.

Compared with the Google smoke examples, these suites are:

- deterministic
- easier to reason about
- structured around test hooks
- better for evaluating reducer quality

Prerequisites:

1. Start the WDIT server from the repo root:

```bash
node dist/server/index.js
```

2. Start the demo app:

```bash
cd apps/demo
npm run build
npm start
```

3. Run one of the demo suites.

After a run, inspect grouped flows from the repo root:

```bash
node dist/cli/index.js flows --verbose
```
