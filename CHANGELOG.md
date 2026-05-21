# Changelog

All notable changes to `wdyt` will be documented in this file.

## 0.1.0

Initial release.

### Capture and review

- Added browser-extension-based capture for automated browser tests.
- Added the observed behaviors review workflow for browsing execution-derived behaviors.
- Added semantic interpretation and proposal generation for observed behaviors.
- Added repeated-coverage grouping based on structural flow identity.

### Expected behavior coverage

- Added expected behaviors management in the UI.
- Added coverage analysis comparing expected behaviors against observed execution evidence.
- Added qualifier-aware partial coverage handling for cases where a core behavior matches but important qualifiers are missing.

### Summary and analysis

- Added a summary view for unique behaviors, repeated coverage, and expected behavior coverage outcomes.
- Added structural grouping for unique behaviors so repeated executions of the same flow stay grouped even when semantic wording drifts.
- Added navigation from summary behaviors into filtered observed-behavior review.

### Artifacts and CI workflows

- Added ZIP artifact export and import for moving captured evidence between environments.
- Added opt-in export waiting with `--wait-for-enrichment` for CI flows that want settled enrichment before archiving.
- Added a browser-native print and save-as-PDF path from the summary view.

### CLI and operations

- Added `wdyt server start`.
- Added `wdyt settings rebuild`.
- Added `wdyt settings synthetic seed` and `wdyt settings synthetic benchmark`.
- Added recovery for stalled proposal processing after interrupted runs or restarts.

### Packaging and release prep

- Added self-hosted bundled fonts used by the UI.
- Tightened npm package contents with a runtime-focused publish allow-list.
- Added Apache 2.0 licensing metadata and packaged license text.
