import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { getDataDir } from "../shared/fs.js";
import { readZipEntries } from "./zip.js";

type Manifest = {
  schemaVersion?: string;
  files?: Array<{
    path?: string;
    size?: number;
  }>;
};

function assertRelativeDataPath(zipPath: string) {
  if (!zipPath.startsWith("data/")) {
    throw new Error(`Artifact file path must start with data/: ${zipPath}`);
  }

  const relativePath = zipPath.slice("data/".length);
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`Artifact file path must be relative: ${zipPath}`);
  }

  const normalized = path.normalize(relativePath);
  if (normalized.startsWith("..") || normalized.includes(`${path.sep}..${path.sep}`) || normalized === "..") {
    throw new Error(`Artifact file path escapes runtime directory: ${zipPath}`);
  }

  return normalized;
}

async function removeExistingRuntimeArtifacts(rootDir: string) {
  async function walk(currentDir: string) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl")) {
        await rm(absolutePath, { force: true });
      }
    }
  }

  await walk(rootDir);
}

function validateManifest(manifest: Manifest, zipEntries: Map<string, Buffer>) {
  if (manifest.schemaVersion !== "1.0") {
    throw new Error(`Unsupported artifact schema version: ${manifest.schemaVersion ?? "missing"}`);
  }

  const fileEntries = Array.isArray(manifest.files) ? manifest.files : [];
  for (const file of fileEntries) {
    if (typeof file.path !== "string") {
      throw new Error("Artifact manifest contains a file entry without a path");
    }
    if (!zipEntries.has(file.path)) {
      throw new Error(`Artifact manifest references missing file: ${file.path}`);
    }
    if (typeof file.size === "number" && zipEntries.get(file.path)?.length !== file.size) {
      throw new Error(`Artifact file size mismatch for ${file.path}`);
    }
  }
}

export async function importArtifact(zipPath: string): Promise<string> {
  const artifactPath = path.resolve(process.cwd(), zipPath);
  const zipBuffer = await readFile(artifactPath);
  const entries = readZipEntries(zipBuffer);
  const entryMap = new Map(entries.map((entry) => [entry.path, entry.content]));
  const manifestBuffer = entryMap.get("manifest.json");

  if (!manifestBuffer) {
    throw new Error("Artifact is missing manifest.json");
  }

  const manifest = JSON.parse(manifestBuffer.toString("utf8")) as Manifest;
  validateManifest(manifest, entryMap);

  const runtimeEntries = entries.filter((entry) => entry.path.startsWith("data/"));
  const dataDir = getDataDir();
  await mkdir(dataDir, { recursive: true });
  await removeExistingRuntimeArtifacts(dataDir);

  for (const entry of runtimeEntries) {
    const relativePath = assertRelativeDataPath(entry.path);
    const destination = path.join(dataDir, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.content);
  }

  return dataDir;
}
