# Selenium Demo Suite

This suite exercises the controlled demo app using Selenium + Chromium with
WDIT integration managed through setup/teardown hooks.

Setup:

```bash
cd examples/demo/selenium
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
npm test
```
