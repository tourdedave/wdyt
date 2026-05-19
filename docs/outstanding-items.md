# Outstanding Items

## Repeated Coverage Normalization

- Current repeated-coverage grouping is good enough for the demo datasets, but it is still not a general semantic clustering solution.
- The overlap normalization in [`src/shared/vocabulary.ts`](/Users/dp/dev/wdyt/src/shared/vocabulary.ts) still relies on deterministic folding that is strongest for the current demo vocab shapes.
- New semantically similar observed behaviors may fail to cluster unless they already normalize through the existing rules or approved vocabulary aliases.

### Follow-up

- Push repeated-coverage normalization further toward generic linguistic simplification and approved-vocabulary canonicalization.
- Reduce demo-specific folding rules where possible.
- Consider embeddings or another semantic-similarity layer only after the deterministic path is exhausted.

## Expected Behavior Coverage Matching

- Expected-behavior coverage still uses a greedy term-coverage pass in [`src/server/critical-flows.ts`](/Users/dp/dev/wdyt/src/server/critical-flows.ts).
- Qualifier-aware partial coverage now exists, but the matcher is still not a final composite-flow or telemetry-aware model.

### Follow-up

- Replace greedy matching with a more telemetry-aware comparison model.
- Use captured evidence as an additional matching source alongside reviewed descriptors.
- Distinguish between "untested" and "not yet reviewed".
- Improve ambiguity handling when vocabulary or semantic interpretation is weak.

## Getting Started Guide

- The first-run getting-started route is still a placeholder.

### Follow-up

- Replace the placeholder content on [`/getting-started`](/Users/dp/dev/wdyt/src/server/index.ts:2967) with real product guidance for capture, review, and export.

## Expected Behavior Duplicate Detection

- Duplicate detection for expected behaviors exists in the page client, but it is still a lightweight UI heuristic.
- It helps the current workflow, but it is not enforced as a shared rule outside the client.

### Follow-up

- Add integration coverage for the duplicate warning and `View Existing Flow` behavior.
- Consider moving duplicate-detection logic into a shared helper if it needs to be enforced beyond the UI.

## Observed Behavior Scaling

- The observed-behaviors page now has a scaled mode with server-backed search and pagination, but the underlying review-unit data is still file-backed.
- The browser footprint is reduced in scaled mode, but larger datasets may still need more careful query/indexing work over time.

### Follow-up

- Continue stress-testing larger merged datasets and synthetic workloads.
- Revisit server-side caching/query behavior if large local review sessions become sluggish.
- Keep the current two-mode UI approach unless real datasets justify a more complex model.

## Docs Coverage

- `/docs` currently contains only this engineering backlog note.
- There is still no current user-facing or operator-facing documentation set for:
  - synthetic seeding/benchmarking
  - manual rebuilds
  - artifact import/export behavior
  - current print/export expectations

### Follow-up

- Add a minimal docs set once the current product surface settles.
- Keep this file focused on active engineering gaps rather than general product explanation.

## Artifact Export Wait Behavior

- `wdyt artifact export --wait-for-enrichment` now waits for `pending` / `processing` review-unit enrichment to settle before writing the artifact.
- This is intentionally opt-in because full queue drain may be too slow for some CI workflows.
- If no worker is draining the queue, the command times out rather than silently exporting an incomplete "fully settled" artifact.

### Follow-up

- Consider clearer operator guidance around when to use `--wait-for-enrichment`.
- Consider richer export-time reporting about how many review units were still pending, processing, proposed, or errored when exporting without the wait flag.
