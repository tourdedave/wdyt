import { mkdir, appendFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function resolveDataDir() {
  const configuredDir = process.env.WDYT_DATA_DIR;

  if (configuredDir) {
    return path.resolve(process.cwd(), configuredDir);
  }

  return path.resolve(process.cwd(), ".wdyt");
}

export function getDataDir() {
  return resolveDataDir();
}

export function getRawRunsPath() {
  return path.join(getDataDir(), "runs.raw.jsonl");
}

export function getProcessedRunsPath() {
  return path.join(getDataDir(), "runs.processed.jsonl");
}

export function getFlowReviewsPath() {
  return path.join(getDataDir(), "flow-reviews.json");
}

export function getVocabularyPath() {
  return path.join(getDataDir(), "vocabulary.json");
}

export function getReviewUnitsPath() {
  return path.join(getDataDir(), "review-units.json");
}

export function getCriticalFlowsPath() {
  return path.join(getDataDir(), "critical-flows.json");
}

export async function ensureDataDir() {
  await mkdir(getDataDir(), { recursive: true });
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
  const tempFilePath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempFilePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempFilePath, filePath);
}
