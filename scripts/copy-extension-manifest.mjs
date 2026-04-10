import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const source = path.join(projectRoot, "extension", "manifest.json");
const targetDir = path.join(projectRoot, "dist", "extension");
const target = path.join(targetDir, "manifest.json");

await mkdir(targetDir, { recursive: true });
await cp(source, target);
