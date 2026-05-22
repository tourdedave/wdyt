import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

await Promise.all([
  rm(path.join(projectRoot, "dist", "wdyt.crx"), { force: true }),
  rm(path.join(projectRoot, "dist", "wdyt-extension.pem"), { force: true }),
]);
