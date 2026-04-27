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

type ParsedArtifact = {
  manifest: Manifest;
  runtimeEntries: Array<{
    path: string;
    content: Buffer;
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

function parseArtifactBuffer(zipBuffer: Buffer): ParsedArtifact {
  const entries = readZipEntries(zipBuffer);
  const entryMap = new Map(entries.map((entry) => [entry.path, entry.content]));
  const manifestBuffer = entryMap.get("manifest.json");

  if (!manifestBuffer) {
    throw new Error("Artifact is missing manifest.json");
  }

  const manifest = JSON.parse(manifestBuffer.toString("utf8")) as Manifest;
  validateManifest(manifest, entryMap);

  return {
    manifest,
    runtimeEntries: entries.filter((entry) => entry.path.startsWith("data/")),
  };
}

async function restoreRuntimeEntries(runtimeEntries: Array<{ path: string; content: Buffer }>) {
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

function mergeJsonArrayEntries(buffers: Buffer[]) {
  const merged: unknown[] = [];
  const seen = new Set<string>();

  for (const buffer of buffers) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      continue;
    }

    if (!Array.isArray(parsed)) {
      continue;
    }

    for (const item of parsed) {
      const key = JSON.stringify(item);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(item);
    }
  }

  return Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

function mergeJsonLineEntries(buffers: Buffer[]) {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const buffer of buffers) {
    const content = buffer.toString("utf8");
    for (const line of content.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
      if (seen.has(line)) {
        continue;
      }
      seen.add(line);
      lines.push(line);
    }
  }

  return Buffer.from(lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
}

export async function importArtifactBuffers(zipBuffers: Buffer[]): Promise<string> {
  if (zipBuffers.length === 0) {
    throw new Error("At least one artifact is required");
  }

  const parsedArtifacts = zipBuffers.map(parseArtifactBuffer);
  if (parsedArtifacts.length === 1) {
    return restoreRuntimeEntries(parsedArtifacts[0].runtimeEntries);
  }

  const entryGroups = new Map<string, Buffer[]>();
  for (const artifact of parsedArtifacts) {
    for (const entry of artifact.runtimeEntries) {
      const current = entryGroups.get(entry.path) ?? [];
      current.push(entry.content);
      entryGroups.set(entry.path, current);
    }
  }

  const mergedEntries = [...entryGroups.entries()].map(([zipPath, buffers]) => {
    const fileName = path.basename(zipPath).toLowerCase();
    const content = fileName.endsWith(".jsonl")
      ? mergeJsonLineEntries(buffers)
      : mergeJsonArrayEntries(buffers);

    return { path: zipPath, content };
  });

  return restoreRuntimeEntries(mergedEntries);
}

export async function importArtifacts(zipPaths: string[]): Promise<string> {
  if (zipPaths.length === 0) {
    throw new Error("At least one artifact is required");
  }

  const zipBuffers = await Promise.all(
    zipPaths.map(async (zipPath) => {
      const artifactPath = path.resolve(process.cwd(), zipPath);
      return readFile(artifactPath);
    })
  );

  return importArtifactBuffers(zipBuffers);
}

export async function importArtifact(zipPath: string): Promise<string> {
  return importArtifacts([zipPath]);
}
