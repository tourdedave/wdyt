import path from "node:path";
import { fileURLToPath } from "node:url";

export function getExtensionPath(importMetaUrl) {
  const currentDir = path.dirname(fileURLToPath(importMetaUrl));
  const repoRoot = path.resolve(currentDir, "..");
  return path.join(repoRoot, "dist", "extension");
}
