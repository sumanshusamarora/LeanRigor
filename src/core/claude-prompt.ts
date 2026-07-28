import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ClaudePromptFile {
  path: string;
  cleanup(): Promise<void>;
}

export async function createClaudePromptFile(prompt: string): Promise<ClaudePromptFile> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "leanrigor-claude-prompt-"));
  const promptPath = path.join(directory, "prompt.txt");
  await writeFile(promptPath, prompt, "utf8");
  let cleaned = false;
  return {
    path: promptPath,
    async cleanup(): Promise<void> {
      if (cleaned) return;
      cleaned = true;
      await rm(directory, { recursive: true, force: true });
    }
  };
}
