import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(appRoot, "src", "static");
const targetDir = path.join(appRoot, "dist", "static");

await mkdir(targetDir, { recursive: true });
await cp(sourceDir, targetDir, { recursive: true });
