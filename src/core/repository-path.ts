const SEMANTIC_PATH_SEGMENTS = new Set([
  "attempt",
  "fallback",
  "json",
  "model",
  "provider",
  "resolved",
  "source",
  "stage",
  "status",
  "tier"
]);

const ROOT_FILE_NAMES = new Set(["makefile", "readme"]);

export function normaliseRepositoryPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");
}

/**
 * Identifies repository-relative paths and globs without accepting model names,
 * versions, or slash-separated provenance labels as source boundaries.
 */
export function isRepositoryPathPattern(value: string): boolean {
  const normalized = normaliseRepositoryPath(value);
  if (!normalized || normalized.startsWith("-") || normalized.startsWith("/") || normalized.split("/").includes("..")) return false;
  const segments = normalized.split("/");
  if (segments.length > 1 && segments.every((segment) => SEMANTIC_PATH_SEGMENTS.has(segment.toLowerCase()))) return false;
  if (segments.some((segment) => /^[a-z][a-z0-9_-]*-\d+(?:\.\d+)+(?:[-_][a-z0-9_-]+)?$/i.test(segment))) return false;
  if (/[?*[{]/.test(normalized)) return true;
  if (segments.length > 1) return true;
  const lower = normalized.toLowerCase();
  return ROOT_FILE_NAMES.has(lower) || /\.[a-z][a-z0-9]*$/i.test(normalized);
}

/** Returns true only for a credible new file target, not an arbitrary directory label. */
export function isPotentialRepositoryFile(value: string): boolean {
  const normalized = normaliseRepositoryPath(value);
  if (!isRepositoryPathPattern(normalized) || /[?*[{]/.test(normalized)) return false;
  const base = normalized.split("/").at(-1) ?? "";
  return ROOT_FILE_NAMES.has(base.toLowerCase()) || /\.[a-z][a-z0-9]*$/i.test(base);
}
