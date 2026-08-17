import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const promptsSourceDir = path.join(projectRoot, "src", "prompts");
const promptsTargetDir = path.join(projectRoot, "dist", "prompts");
const fontsSourceDir = path.join(projectRoot, "public", "fonts");
const fontsTargetDir = path.join(projectRoot, "dist", "public", "fonts");
const docsSourceDir = path.join(projectRoot, "docs");
const docsTargetDir = path.join(projectRoot, "dist", "docs");

await mkdir(promptsTargetDir, { recursive: true });
await cp(promptsSourceDir, promptsTargetDir, { recursive: true });

await mkdir(fontsTargetDir, { recursive: true });
await cp(fontsSourceDir, fontsTargetDir, { recursive: true });

await mkdir(docsTargetDir, { recursive: true });
await cp(path.join(docsSourceDir, "getting-started.md"), path.join(docsTargetDir, "getting-started.md"));
