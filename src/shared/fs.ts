import { mkdir, appendFile, readFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), ".wdit");

export function getDataDir() {
  return DATA_DIR;
}

export function getRawRunsPath() {
  return path.join(DATA_DIR, "runs.raw.jsonl");
}

export function getProcessedRunsPath() {
  return path.join(DATA_DIR, "runs.processed.jsonl");
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
