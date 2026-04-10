import type { SuiteInfo } from "./types.js";

export function normalizeName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

export function createSuiteInfo(name: string): SuiteInfo {
  const normalizedName = normalizeName(name);

  return {
    id: normalizedName,
    name,
    normalizedName,
  };
}
