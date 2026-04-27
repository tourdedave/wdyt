import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDataDir } from "../shared/fs.js";
import { buildZip, toZipPath } from "./zip.js";

type ArtifactFile = {
  absolutePath: string;
  zipPath: string;
  size: number;
  content: Buffer;
};

type Manifest = {
  artifactId: string;
  createdAt: string;
  wdytVersion: string | null;
  schemaVersion: "1.0";
  metadata: {
    branch: string | null;
    commitSha: string | null;
    buildId: string | null;
    environment: string | null;
  };
  files: Array<{
    path: string;
    size: number;
  }>;
  entrypoints: Record<string, string>;
  stats: Record<string, number>;
  canonicalization: {
    reducerVersion: string | null;
    vocabVersion: string | null;
    llmModel: string | null;
    llmVersion: string | null;
  };
};

async function collectRuntimeArtifacts(rootDir: string) {
  const files: ArtifactFile[] = [];

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

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!entry.name.endsWith(".json") && !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const content = await readFile(absolutePath);
      const relativePath = path.relative(rootDir, absolutePath);
      files.push({
        absolutePath,
        zipPath: toZipPath("data", relativePath),
        size: content.length,
        content,
      });
    }
  }

  await walk(rootDir);
  return files.sort((left, right) => left.zipPath.localeCompare(right.zipPath));
}

async function readWdytVersion() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../package.json"),
    path.resolve(process.cwd(), "package.json"),
  ];

  for (const candidate of candidates) {
    try {
      const packageJson = JSON.parse(await readFile(candidate, "utf8")) as {
        version?: string;
      };
      if (typeof packageJson.version === "string") {
        return packageJson.version;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function detectEntrypoints(files: ArtifactFile[]) {
  const entrypoints: Record<string, string> = {};

  for (const file of files) {
    const basename = path.basename(file.zipPath).toLowerCase();

    if (!entrypoints.rawRuns && basename.includes("runs.raw.jsonl")) {
      entrypoints.rawRuns = file.zipPath;
      continue;
    }

    if (!entrypoints.processedRuns && basename.includes("runs.processed.jsonl")) {
      entrypoints.processedRuns = file.zipPath;
      continue;
    }

    if (!entrypoints.reviewUnits && basename === "review-units.json") {
      entrypoints.reviewUnits = file.zipPath;
      continue;
    }

    if (!entrypoints.vocabulary && basename === "vocabulary.json") {
      entrypoints.vocabulary = file.zipPath;
      continue;
    }

    if (!entrypoints.criticalFlows && basename === "critical-flows.json") {
      entrypoints.criticalFlows = file.zipPath;
    }
  }

  return entrypoints;
}

function countJsonLines(content: Buffer) {
  const text = content.toString("utf8").trim();
  if (!text) {
    return 0;
  }
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

function countJsonArray(content: Buffer) {
  try {
    const parsed = JSON.parse(content.toString("utf8"));
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function buildStats(files: ArtifactFile[], entrypoints: Record<string, string>) {
  const stats: Record<string, number> = {
    totalFiles: files.length,
  };

  const fileByZipPath = new Map(files.map((file) => [file.zipPath, file]));

  if (entrypoints.rawRuns) {
    stats.totalRawRecords = countJsonLines(fileByZipPath.get(entrypoints.rawRuns)?.content ?? Buffer.alloc(0));
  }

  if (entrypoints.processedRuns) {
    stats.totalProcessedRecords = countJsonLines(fileByZipPath.get(entrypoints.processedRuns)?.content ?? Buffer.alloc(0));
  }

  if (entrypoints.reviewUnits) {
    stats.totalReviewUnits = countJsonArray(fileByZipPath.get(entrypoints.reviewUnits)?.content ?? Buffer.alloc(0));
  }

  if (entrypoints.criticalFlows) {
    stats.totalCriticalFlows = countJsonArray(fileByZipPath.get(entrypoints.criticalFlows)?.content ?? Buffer.alloc(0));
  }

  return stats;
}

function buildManifest(files: ArtifactFile[], createdAt: string, wdytVersion: string | null): Manifest {
  const entrypoints = detectEntrypoints(files);

  return {
    artifactId: randomUUID(),
    createdAt,
    wdytVersion,
    schemaVersion: "1.0",
    metadata: {
      branch: process.env.GIT_BRANCH ?? null,
      commitSha: process.env.GIT_COMMIT ?? null,
      buildId: process.env.BUILD_ID ?? null,
      environment: process.env.NODE_ENV ?? null,
    },
    files: files.map((file) => ({
      path: file.zipPath,
      size: file.size,
    })),
    entrypoints,
    stats: buildStats(files, entrypoints),
    canonicalization: {
      reducerVersion: null,
      vocabVersion: null,
      llmModel: process.env.WDYT_LLM_MODEL ?? null,
      llmVersion: null,
    },
  };
}

export async function buildArtifact(): Promise<string> {
  return buildArtifactWithOptions();
}

export async function buildArtifactWithOptions(options?: { outputPath?: string }): Promise<string> {
  const dataDir = getDataDir();
  const snapshotTime = new Date();
  const createdAt = snapshotTime.toISOString();
  const wdytVersion = await readWdytVersion();
  const files = await collectRuntimeArtifacts(dataDir);
  const manifest = buildManifest(files, createdAt, wdytVersion);
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const zipBuffer = buildZip(
    [
      {
        path: "manifest.json",
        content: manifestBuffer,
        modifiedAt: snapshotTime,
      },
      ...files.map((file) => ({
        path: file.zipPath,
        content: file.content,
        modifiedAt: snapshotTime,
      })),
    ].sort((left, right) => left.path.localeCompare(right.path))
  );

  return writeArtifactZip({
    createdAt,
    artifactId: manifest.artifactId,
    zipBuffer,
    outputPath: options?.outputPath,
    dataDir,
  });
}

async function writeArtifactZip(input: {
  createdAt: string;
  artifactId: string;
  zipBuffer: Buffer;
  outputPath?: string;
  dataDir: string;
}) {
  const defaultFileName = `wdyt-artifact-${input.createdAt.replace(/[:.]/g, "-")}-${input.artifactId}.zip`;
  const resolvedOutputPath = input.outputPath
    ? path.resolve(process.cwd(), input.outputPath)
    : path.join(path.resolve(path.dirname(input.dataDir), ".wdyt-artifacts"), defaultFileName);

  const destination =
    path.extname(resolvedOutputPath).toLowerCase() === ".zip"
      ? resolvedOutputPath
      : path.join(resolvedOutputPath, defaultFileName);

  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, input.zipBuffer);
  return destination;
}
