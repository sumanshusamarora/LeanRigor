import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  mergeLeanRigorHooks,
  removeLeanRigorHooks,
  checkSettingsState,
} from "../../../src/adapters/claude/settings-merger.js";

const PACKAGED_SETTINGS = JSON.stringify({
  "_leanrigor": "generated_by: leanrigor | asset_version: 1",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "sh .claude/leanrigor/protect-git.sh"
          }
        ]
      }
    ]
  }
}, null, 2) + "\n";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "leanrigor-settings-merger-"));
}

async function writePackaged(dir: string): Promise<string> {
  const p = path.join(dir, "packaged-settings.json");
  await writeFile(p, PACKAGED_SETTINGS, "utf8");
  return p;
}

describe("mergeLeanRigorHooks", () => {
  it("creates settings.json from packaged template when target is missing", async () => {
    const dir = await tempDir();
    const packagedPath = await writePackaged(dir);
    const targetPath = path.join(dir, ".claude", "settings.json");

    const result = await mergeLeanRigorHooks(targetPath, packagedPath);

    expect(result.modified).toBe(true);
    expect(result.state).toBe("shared_merged");
    const content = await readFile(targetPath, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain("protect-git.sh");
  });

  it("merges LR hook into existing settings.json without LR entries", async () => {
    const dir = await tempDir();
    const packagedPath = await writePackaged(dir);
    const targetPath = path.join(dir, "settings.json");
    await writeFile(targetPath, JSON.stringify({
      theme: "dark",
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo hi" }] }] }
    }, null, 2) + "\n", "utf8");

    const result = await mergeLeanRigorHooks(targetPath, packagedPath);

    expect(result.modified).toBe(true);
    expect(result.state).toBe("shared_merged");
    const content = await readFile(targetPath, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.theme).toBe("dark");
    expect(parsed.hooks.UserPromptSubmit).toBeDefined();
    expect(parsed.hooks.PreToolUse).toBeDefined();
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain("protect-git.sh");
  });

  it("updates stale LR hook entry", async () => {
    const dir = await tempDir();
    const packagedPath = await writePackaged(dir);
    const targetPath = path.join(dir, "settings.json");
    await writeFile(targetPath, JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{ type: "command", command: "sh .claude/leanrigor/protect-git.sh" }]
        }]
      }
    }, null, 2) + "\n", "utf8");

    const result = await mergeLeanRigorHooks(targetPath, packagedPath);

    expect(result.modified).toBe(false);
    expect(result.state).toBe("shared_current");
  });

  it("removes duplicate LR entries and keeps one", async () => {
    const dir = await tempDir();
    const packagedPath = await writePackaged(dir);
    const targetPath = path.join(dir, "settings.json");
    await writeFile(targetPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "sh .claude/leanrigor/protect-git.sh" }] },
          { matcher: "Bash", hooks: [{ type: "command", command: "sh .claude/leanrigor/protect-git.sh" }] }
        ]
      }
    }, null, 2) + "\n", "utf8");

    const result = await mergeLeanRigorHooks(targetPath, packagedPath);

    expect(result.modified).toBe(true);
    const content = await readFile(targetPath, "utf8");
    const parsed = JSON.parse(content);
    // Should have exactly one LR entry after merge
    const lrEntries = parsed.hooks.PreToolUse.filter(
      (e: { hooks?: Array<{ command?: string }> }) =>
        e.hooks?.some((h) => h.command?.includes("protect-git.sh"))
    );
    expect(lrEntries.length).toBe(1);
  });

  it("preserves unrelated user settings and hooks", async () => {
    const dir = await tempDir();
    const packagedPath = await writePackaged(dir);
    const targetPath = path.join(dir, "settings.json");
    const userSettings = {
      theme: "light",
      model: "opus",
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "codegraph prompt-hook" }] }
        ],
        PostToolUse: [
          { hooks: [{ type: "prompt", prompt: "review changes" }] }
        ]
      }
    };
    await writeFile(targetPath, JSON.stringify(userSettings, null, 2) + "\n", "utf8");

    const result = await mergeLeanRigorHooks(targetPath, packagedPath);

    expect(result.modified).toBe(true);
    const content = await readFile(targetPath, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.theme).toBe("light");
    expect(parsed.model).toBe("opus");
    expect(parsed.hooks.UserPromptSubmit).toBeDefined();
    expect(parsed.hooks.PostToolUse).toBeDefined();
    expect(parsed.hooks.PreToolUse).toBeDefined();
  });

  it("returns shared_malformed for invalid JSON", async () => {
    const dir = await tempDir();
    const packagedPath = await writePackaged(dir);
    const targetPath = path.join(dir, "settings.json");
    await writeFile(targetPath, "{not valid json", "utf8");

    const result = await mergeLeanRigorHooks(targetPath, packagedPath);

    expect(result.modified).toBe(false);
    expect(result.state).toBe("shared_malformed");
  });

  it("is repeat-safe (idempotent)", async () => {
    const dir = await tempDir();
    const packagedPath = await writePackaged(dir);
    const targetPath = path.join(dir, "settings.json");

    // First merge
    const r1 = await mergeLeanRigorHooks(targetPath, packagedPath);
    expect(r1.modified).toBe(true);

    // Second merge — no changes needed
    const r2 = await mergeLeanRigorHooks(targetPath, packagedPath);
    expect(r2.modified).toBe(false);
    expect(r2.state).toBe("shared_current");

    // Content should be identical after both merges
    const content = await readFile(targetPath, "utf8");
    expect(() => JSON.parse(content)).not.toThrow();
  });
});

describe("removeLeanRigorHooks", () => {
  it("removes LR entries while preserving other settings", async () => {
    const dir = await tempDir();
    const packagedPath = await writePackaged(dir);
    const targetPath = path.join(dir, "settings.json");

    // First merge to create settings with LR hooks
    await mergeLeanRigorHooks(targetPath, packagedPath);

    // Add a user hook
    const content = await readFile(targetPath, "utf8");
    const parsed = JSON.parse(content);
    parsed.hooks.UserPromptSubmit = [
      { hooks: [{ type: "command", command: "echo user hook" }] }
    ];
    await writeFile(targetPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");

    const result = await removeLeanRigorHooks(targetPath);

    expect(result.modified).toBe(true);
    expect(result.state).toBe("shared_removed");
    const afterContent = await readFile(targetPath, "utf8");
    const afterParsed = JSON.parse(afterContent);
    // User hook preserved
    expect(afterParsed.hooks.UserPromptSubmit).toBeDefined();
    // LR hook removed
    const hasLR = (afterParsed.hooks.PreToolUse || []).some(
      (e: { hooks?: Array<{ command?: string }> }) =>
        e.hooks?.some((h) => h.command?.includes("protect-git.sh"))
    );
    expect(hasLR).toBe(false);
  });

  it("handles missing settings file gracefully", async () => {
    const dir = await tempDir();
    const result = await removeLeanRigorHooks(path.join(dir, "settings.json"));
    expect(result.modified).toBe(false);
    expect(result.state).toBe("shared_current");
  });
});

describe("checkSettingsState", () => {
  it("returns shared_current when LR entries are present and match", async () => {
    const dir = await tempDir();
    const packagedPath = await writePackaged(dir);
    const targetPath = path.join(dir, "settings.json");
    await mergeLeanRigorHooks(targetPath, packagedPath);

    const result = await checkSettingsState(targetPath, packagedPath);
    expect(result.state).toBe("shared_current");
  });

  it("returns shared_missing_leanrigor_entries when LR entries are absent", async () => {
    const dir = await tempDir();
    const packagedPath = await writePackaged(dir);
    const targetPath = path.join(dir, "settings.json");
    await writeFile(targetPath, JSON.stringify({ theme: "dark" }, null, 2) + "\n", "utf8");

    const result = await checkSettingsState(targetPath, packagedPath);
    expect(result.state).toBe("shared_missing_leanrigor_entries");
  });

  it("returns shared_missing_leanrigor_entries for missing file", async () => {
    const dir = await tempDir();
    const packagedPath = await writePackaged(dir);
    const result = await checkSettingsState(path.join(dir, "settings.json"), packagedPath);
    expect(result.state).toBe("shared_missing_leanrigor_entries");
  });

  it("returns shared_malformed for invalid JSON", async () => {
    const dir = await tempDir();
    const packagedPath = await writePackaged(dir);
    const targetPath = path.join(dir, "settings.json");
    await writeFile(targetPath, "not json", "utf8");

    const result = await checkSettingsState(targetPath, packagedPath);
    expect(result.state).toBe("shared_malformed");
  });

  it("returns shared_conflicting_leanrigor_entries when LR entries differ", async () => {
    const dir = await tempDir();
    const packagedPath = await writePackaged(dir);
    const targetPath = path.join(dir, "settings.json");
    // Create settings with a similar but different LR entry
    await writeFile(targetPath, JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{ type: "command", command: "sh .claude/leanrigor/protect-git.sh --modified" }]
        }]
      }
    }, null, 2) + "\n", "utf8");

    const result = await checkSettingsState(targetPath, packagedPath);
    expect(result.state).toBe("shared_conflicting_leanrigor_entries");
  });
});
