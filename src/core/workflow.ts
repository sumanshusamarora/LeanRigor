import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkflowState } from "./types.js";

export const STATE_DIR = ".leanrigor";
export const STATE_FILE = "workflow.json";

export async function saveWorkflow(root: string, state: WorkflowState): Promise<void> {
  const dir = path.join(root, STATE_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, STATE_FILE), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + "\n");
}

export async function loadWorkflow(root: string): Promise<WorkflowState | undefined> {
  try {
    const raw = await readFile(path.join(root, STATE_DIR, STATE_FILE), "utf8");
    return JSON.parse(raw) as WorkflowState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
