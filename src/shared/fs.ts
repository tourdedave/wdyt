import { existsSync } from "node:fs";
import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function resolveDataDir() {
  const configuredDir = process.env.WDYT_DATA_DIR ?? process.env.WDIT_DATA_DIR;

  if (configuredDir) {
    return path.resolve(process.cwd(), configuredDir);
  }

  const nextDataDir = path.resolve(process.cwd(), ".wdyt");
  if (existsSync(nextDataDir)) {
    return nextDataDir;
  }

  const legacyDataDir = path.resolve(process.cwd(), ".wdit");
  if (existsSync(legacyDataDir)) {
    return legacyDataDir;
  }

  return nextDataDir;
}

const DATA_DIR = resolveDataDir();

export function getDataDir() {
  return DATA_DIR;
}

export function getRawRunsPath() {
  return path.join(DATA_DIR, "runs.raw.jsonl");
}

export function getProcessedRunsPath() {
  return path.join(DATA_DIR, "runs.processed.jsonl");
}

export function getFlowReviewsPath() {
  return path.join(DATA_DIR, "flow-reviews.json");
}

export function getVocabularyPath() {
  return path.join(DATA_DIR, "vocabulary.json");
}

export function getReviewUnitsPath() {
  return path.join(DATA_DIR, "review-units.json");
}

export async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

export async function appendJsonLine(filePath: string, value: unknown) {
  await ensureDataDir();
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export async function readJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    const content = await readFile(filePath, "utf8");

    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

export async function writeJsonFile(filePath: string, value: unknown) {
  await ensureDataDir();
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
