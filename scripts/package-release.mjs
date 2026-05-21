import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { buildZip, toZipPath } from "../dist/artifact/zip.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const releaseDir = path.join(projectRoot, "release");
const extensionDir = path.join(projectRoot, "dist", "extension");
const packageJsonPath = path.join(projectRoot, "package.json");

async function collectFiles(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(rootDir, absolutePath)));
      continue;
    }

    const relativePath = path.relative(rootDir, absolutePath);
    files.push({
      absolutePath,
      relativePath,
      stats: await stat(absolutePath),
    });
  }

  return files;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function buildExtensionZip(version) {
  const files = await collectFiles(extensionDir);
  const entries = await Promise.all(
    files.map(async (file) => ({
      path: toZipPath(file.relativePath),
      content: await readFile(file.absolutePath),
      modifiedAt: file.stats.mtime,
    })),
  );

  const zipBuffer = buildZip(entries);
  const outputName = `wdyt-extension-${version}.zip`;
  const outputPath = path.join(releaseDir, outputName);
  await writeFile(outputPath, zipBuffer);
  return {
    filename: outputName,
    outputPath,
    checksum: sha256(zipBuffer),
  };
}

async function buildNpmTarball() {
  const npmCacheDir = await mkdtemp(path.join(os.tmpdir(), "wdyt-npm-pack-"));
  try {
    const raw = execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", releaseDir, "--cache", npmCacheDir],
      {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const [result] = JSON.parse(raw);
    const tarballPath = path.join(releaseDir, result.filename);
    const tarballBuffer = await readFile(tarballPath);
    return {
      filename: result.filename,
      outputPath: tarballPath,
      checksum: sha256(tarballBuffer),
    };
  } finally {
    await rm(npmCacheDir, { recursive: true, force: true });
  }
}

async function main() {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const version = packageJson.version;

  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });

  const [npmTarball, extensionZip] = await Promise.all([
    buildNpmTarball(),
    buildExtensionZip(version),
  ]);

  const checksums = [
    `${npmTarball.checksum}  ${npmTarball.filename}`,
    `${extensionZip.checksum}  ${extensionZip.filename}`,
  ].join("\n");
  await writeFile(path.join(releaseDir, "SHA256SUMS.txt"), `${checksums}\n`);

  console.log(`Created release artifacts in ${releaseDir}`);
  console.log(`- ${npmTarball.filename}`);
  console.log(`- ${extensionZip.filename}`);
  console.log("- SHA256SUMS.txt");
}

await main();
