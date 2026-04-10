import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const extensionDir = path.join(projectRoot, "dist", "extension");

const extensionFiles = ["content.js", "background.js", "page-bridge.js"];

for (const fileName of extensionFiles) {
  const filePath = path.join(extensionDir, fileName);
  const source = await readFile(filePath, "utf8");
  const fixed = source.replace(/^\s*export \{\};\s*$/gmu, "").trimEnd() + "\n";

  if (fixed !== source) {
    await writeFile(filePath, fixed, "utf8");
  }
}
