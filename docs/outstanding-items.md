# Outstanding Items

## Review Repeated Coverage

- Current repeated-coverage matching is sufficient for the demo, but it is not a general solution yet.
- The current overlap normalization in [`src/shared/vocabulary.ts`](/Users/dp/dev/wdyt/src/shared/vocabulary.ts) uses hard-coded term folding for the current demo vocab shapes.
- This means new semantically similar review-unit vocab may fail to cluster unless it matches one of the existing rules or is already unified through approved vocabulary aliases.
- After deleting `.wdyt` data and rerunning the current demo suites, the dashboard/search overlap cases should group correctly.

### Follow-up

- Replace demo-specific overlap folding with a more general semantic normalization approach.
- Prefer approved-vocabulary canonicalization and generic linguistic simplification over term-specific hard-coded folds.
- Consider embeddings or another semantic similarity layer only after the deterministic normalization path is pushed further.

## Critical Flow Coverage Matching

- Critical-flow coverage still uses a greedy term-coverage pass in [`src/server/critical-flows.ts`](/Users/dp/dev/wdyt/src/server/critical-flows.ts).
- This is good enough for current behavior, but not a final composite-flow matching model.

### Follow-up

- Replace greedy matching with graph- or telemetry-aware matching.
- Use telemetry evidence as an additional matching source alongside reviewed descriptors.
- Distinguish between "untested" and "not yet reviewed".
- Add confidence handling for vocabulary mismatch or semantic ambiguity.

## Capture Guide

- The first-run capture guide route is still a placeholder.

### Follow-up

- Replace the TODO content on `/critical-flows/capture-guide` with real product guidance.

## Critical Flow Duplicate Detection

- Duplicate detection for critical flows exists in the page client, but it is still a lightweight UI heuristic.
- There is no dedicated integration test covering that duplicate warning flow yet.

### Follow-up

- Add integration coverage for the duplicate warning and "View Existing Flow" behavior.
- Consider moving duplicate-detection logic into a shared helper if it needs to be enforced outside the UI.
