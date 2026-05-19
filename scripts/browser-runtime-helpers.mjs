import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

export function getExtensionPath(importMetaUrl) {
  let currentDir = path.dirname(fileURLToPath(importMetaUrl));

  while (true) {
    const candidate = path.join(currentDir, "dist", "extension", "manifest.json");
    if (fs.existsSync(candidate)) {
      return path.dirname(candidate);
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error("Unable to locate dist/extension from current script path");
    }

    currentDir = parentDir;
  }
}

export function getHeadlessMode() {
  return process.env.HEADLESS === "1";
}

export function getChromiumBinary() {
  const defaultChromiumBinary =
    process.platform === "darwin" ? "/Applications/Chromium.app/Contents/MacOS/Chromium" : null;

  return process.env.CHROMIUM_BINARY ?? defaultChromiumBinary;
}
