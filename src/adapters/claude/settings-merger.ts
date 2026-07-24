import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * LeanRigor-owned hook entry identifying marker.
 * Any PreToolUse hook entry whose command references this path is considered
 * LeanRigor-owned and may be safely replaced or removed during merge/uninstall.
 */
const PROTECT_GIT_PATH = "protect-git.sh";

export interface MergeResult {
  /** Whether the settings file was modified */
  modified: boolean;
  /** State after merge: shared_current, shared_merged, shared_malformed, shared_unwritable */
  state: "shared_current" | "shared_merged" | "shared_malformed" | "shared_unwritable";
  /** Human-readable description */
  detail: string;
}

export interface RemoveResult {
  /** Whether the settings file was modified */
  modified: boolean;
  /** State after removal */
  state: "shared_current" | "shared_removed" | "shared_malformed" | "shared_unwritable";
  /** Human-readable description */
  detail: string;
}

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
  [key: string]: unknown;
}

/**
 * Merge LeanRigor-owned hook entries into an existing .claude/settings.json.
 *
 * Reads the packaged (source) settings to extract only the LR-owned PreToolUse
 * entry, then upserts it into the target settings file. All other user settings
 * and hooks are preserved.
 */
export async function mergeLeanRigorHooks(
  settingsPath: string,
  packagedSettingsPath: string,
): Promise<MergeResult> {
  // 1. Load current settings (or default empty)
  let current: Record<string, unknown>;
  let currentRaw: string;
  try {
    currentRaw = await readFile(settingsPath, "utf8");
    current = JSON.parse(currentRaw) as Record<string, unknown>;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      // File missing — create from packaged template
      return createFromPackaged(settingsPath, packagedSettingsPath);
    }
    if (err instanceof SyntaxError) {
      return {
        modified: false,
        state: "shared_malformed",
        detail: "present but not valid JSON (shared_malformed)",
      };
    }
    return {
      modified: false,
      state: "shared_unwritable",
      detail: `cannot read: ${(err as Error).message}`,
    };
  }

  // 2. Load packaged LR settings template
  let packaged: Record<string, unknown>;
  try {
    const packagedRaw = await readFile(packagedSettingsPath, "utf8");
    packaged = JSON.parse(packagedRaw) as Record<string, unknown>;
  } catch {
    return {
      modified: false,
      state: "shared_unwritable",
      detail: "packaged settings template not found or unreadable",
    };
  }

  // 3. Extract the LR-owned PreToolUse entry from packaged settings
  const lrEntry = extractLRPreToolUseEntry(packaged);
  if (!lrEntry) {
    return {
      modified: false,
      state: "shared_unwritable",
      detail: "packaged settings does not contain a valid LR PreToolUse entry",
    };
  }

  // 4. Upsert the LR entry into current settings
  const modified = upsertLRHook(current, lrEntry);

  if (!modified) {
    return {
      modified: false,
      state: "shared_current",
      detail: "current (LeanRigor hook entries present; coexists with user settings)",
    };
  }

  // 5. Write back
  try {
    await writeFile(settingsPath, JSON.stringify(current, null, 2) + "\n", "utf8");
  } catch (err: unknown) {
    return {
      modified: false,
      state: "shared_unwritable",
      detail: `cannot write: ${(err as Error).message}`,
    };
  }

  return {
    modified: true,
    state: "shared_merged",
    detail: "LeanRigor hook entries merged (coexists with user settings)",
  };
}

/**
 * Remove LeanRigor-owned hook entries from .claude/settings.json.
 * Preserves all other user settings and hooks.
 */
export async function removeLeanRigorHooks(settingsPath: string): Promise<RemoveResult> {
  let current: Record<string, unknown>;
  try {
    const raw = await readFile(settingsPath, "utf8");
    current = JSON.parse(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { modified: false, state: "shared_current", detail: "settings.json not found" };
    }
    if (err instanceof SyntaxError) {
      return { modified: false, state: "shared_malformed", detail: "not valid JSON" };
    }
    return { modified: false, state: "shared_unwritable", detail: `cannot read: ${(err as Error).message}` };
  }

  const modified = removeLRPreToolUseEntries(current);

  if (!modified) {
    return { modified: false, state: "shared_current", detail: "no LeanRigor entries to remove" };
  }

  try {
    await writeFile(settingsPath, JSON.stringify(current, null, 2) + "\n", "utf8");
  } catch (err: unknown) {
    return { modified: false, state: "shared_unwritable", detail: `cannot write: ${(err as Error).message}` };
  }

  return { modified: true, state: "shared_removed", detail: "LeanRigor hook entries removed" };
}

/**
 * Check whether a settings.json file contains current LeanRigor hook entries.
 * Used by inspectAssets to determine the settings state without modifying.
 */
export async function checkSettingsState(
  settingsPath: string,
  packagedSettingsPath: string,
): Promise<{
  state: "shared_current" | "shared_missing_leanrigor_entries" | "shared_conflicting_leanrigor_entries" | "shared_malformed" | "shared_unwritable";
  detail: string;
}> {
  let current: Record<string, unknown>;
  try {
    const raw = await readFile(settingsPath, "utf8");
    current = JSON.parse(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { state: "shared_missing_leanrigor_entries", detail: "missing" };
    }
    if (err instanceof SyntaxError) {
      return { state: "shared_malformed", detail: "present but not valid JSON (shared_malformed)" };
    }
    return { state: "shared_unwritable", detail: `cannot read: ${(err as Error).message}` };
  }

  let packaged: Record<string, unknown>;
  try {
    const packagedRaw = await readFile(packagedSettingsPath, "utf8");
    packaged = JSON.parse(packagedRaw) as Record<string, unknown>;
  } catch {
    return { state: "shared_unwritable", detail: "packaged settings template unreadable" };
  }

  const lrEntry = extractLRPreToolUseEntry(packaged);
  if (!lrEntry) {
    return { state: "shared_unwritable", detail: "packaged settings invalid" };
  }

  const hasLR = hasLRPreToolUseEntries(current);
  if (!hasLR) {
    return { state: "shared_missing_leanrigor_entries", detail: "present but does not contain LeanRigor-owned hook entries (shared configuration)" };
  }

  // Check if the existing LR entry matches the packaged version
  const hasCurrent = lrEntriesMatch(current, lrEntry);
  if (!hasCurrent) {
    return { state: "shared_conflicting_leanrigor_entries", detail: "LeanRigor hook entries present but differ from expected (shared_conflicting_leanrigor_entries)" };
  }

  return { state: "shared_current", detail: "current (LeanRigor hook entries present; coexists with user settings)" };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Create settings.json from the packaged template when the target is missing. */
async function createFromPackaged(settingsPath: string, packagedSettingsPath: string): Promise<MergeResult> {
  let packaged: string;
  try {
    packaged = await readFile(packagedSettingsPath, "utf8");
  } catch {
    return { modified: false, state: "shared_unwritable", detail: "packaged settings template not found" };
  }

  // Validate it's parseable
  try { JSON.parse(packaged); } catch {
    return { modified: false, state: "shared_unwritable", detail: "packaged settings template is not valid JSON" };
  }

  try {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, packaged, "utf8");
  } catch (err: unknown) {
    return { modified: false, state: "shared_unwritable", detail: `cannot create: ${(err as Error).message}` };
  }

  return {
    modified: true,
    state: "shared_merged",
    detail: "created with LeanRigor hook entries",
  };
}

/**
 * Extract the LeanRigor-owned PreToolUse entry from packaged settings.
 * Returns the hook entry object or undefined if not found.
 */
function extractLRPreToolUseEntry(packaged: Record<string, unknown>): HookEntry | undefined {
  const hooks = packaged.hooks as Record<string, unknown> | undefined;
  if (!hooks) return undefined;

  const preToolUse = hooks.PreToolUse as HookEntry[] | undefined;
  if (!preToolUse || !Array.isArray(preToolUse)) return undefined;

  return preToolUse.find((entry) => isLRHookEntry(entry));
}

/**
 * Check if a hook entry is LeanRigor-owned (references protect-git.sh).
 */
function isLRHookEntry(entry: HookEntry): boolean {
  if (!entry.hooks || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) => typeof h.command === "string" && h.command.includes(PROTECT_GIT_PATH));
}

/**
 * Upsert the LR-owned PreToolUse entry into the current settings.
 * Returns true if the settings were modified.
 */
function upsertLRHook(current: Record<string, unknown>, lrEntry: HookEntry): boolean {
  // Ensure hooks object exists
  if (!current.hooks || typeof current.hooks !== "object" || Array.isArray(current.hooks)) {
    current.hooks = {};
  }
  const hooks = current.hooks as Record<string, unknown>;

  // Ensure PreToolUse array exists
  if (!hooks.PreToolUse || !Array.isArray(hooks.PreToolUse)) {
    hooks.PreToolUse = [];
  }
  let preToolUse = hooks.PreToolUse as HookEntry[];

  // Find existing LR entry
  const existingIndex = preToolUse.findIndex((entry) => isLRHookEntry(entry));

  // Deep-compare: if existing entry matches packaged exactly, no change needed
  if (existingIndex >= 0 && deepEqual(preToolUse[existingIndex], lrEntry)) {
    // Remove any duplicate LR entries
    const duplicates = preToolUse.filter((entry, idx) => idx !== existingIndex && isLRHookEntry(entry));
    if (duplicates.length > 0) {
      preToolUse = preToolUse.filter((entry) => !isLRHookEntry(entry) || entry === preToolUse[existingIndex]);
      hooks.PreToolUse = preToolUse;
      return true; // modified: removed duplicates
    }
    return false;
  }

  // Remove all LR entries (stale or duplicates)
  preToolUse = preToolUse.filter((entry) => !isLRHookEntry(entry));

  // Add the current LR entry
  preToolUse.push(lrEntry);
  hooks.PreToolUse = preToolUse;

  return true;
}

/**
 * Check if current settings already contain LR-owned PreToolUse entries.
 */
function hasLRPreToolUseEntries(current: Record<string, unknown>): boolean {
  const hooks = current.hooks as Record<string, unknown> | undefined;
  if (!hooks) return false;

  const preToolUse = hooks.PreToolUse as HookEntry[] | undefined;
  if (!preToolUse || !Array.isArray(preToolUse)) return false;

  return preToolUse.some((entry) => isLRHookEntry(entry));
}

/**
 * Check if the existing LR entries match the packaged version.
 */
function lrEntriesMatch(current: Record<string, unknown>, lrEntry: HookEntry): boolean {
  const hooks = current.hooks as Record<string, unknown> | undefined;
  if (!hooks) return false;

  const preToolUse = hooks.PreToolUse as HookEntry[] | undefined;
  if (!preToolUse || !Array.isArray(preToolUse)) return false;

  const existing = preToolUse.find((entry) => isLRHookEntry(entry));
  if (!existing) return false;

  return deepEqual(existing, lrEntry);
}

/**
 * Remove all LR-owned PreToolUse entries from current settings.
 * Returns true if any entries were removed.
 */
function removeLRPreToolUseEntries(current: Record<string, unknown>): boolean {
  const hooks = current.hooks as Record<string, unknown> | undefined;
  if (!hooks) return false;

  const preToolUse = hooks.PreToolUse as HookEntry[] | undefined;
  if (!preToolUse || !Array.isArray(preToolUse)) return false;

  const before = preToolUse.length;
  hooks.PreToolUse = preToolUse.filter((entry) => !isLRHookEntry(entry));

  // If PreToolUse is now empty, remove it
  if ((hooks.PreToolUse as HookEntry[]).length === 0) {
    delete hooks.PreToolUse;
    // If hooks is now empty, remove it too
    if (Object.keys(hooks).length === 0) {
      delete current.hooks;
    }
  }

  return before !== ((hooks.PreToolUse as HookEntry[] | undefined)?.length ?? 0);
}

/**
 * Simple deep equality for JSON-compatible objects.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
