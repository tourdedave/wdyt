# Selenium Demo Suite

This suite exercises the controlled demo app using Selenium + Chromium with
wdyt integration managed through setup/teardown hooks.

Setup:

```bash
cd demo
npm install
```

On macOS, install Chromium with:

```bash
brew install --cask chromium
```

If macOS blocks Chromium, remove quarantine metadata and launch it once
manually:

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

Optional bounded parallelism:

```bash
DEMO_CONCURRENCY=10 npm run test:selenium
```
