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
