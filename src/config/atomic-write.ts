import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Atomically write JSON to a file using temp-file + rename.
 *
 * Guarantees the target file is never observed in a partially-written state.
 * On failure the temp file is left behind for inspection (os.tmpdir).
 */
export async function atomicWriteJson(filePath: string, data: unknown, pretty = true): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  const content = JSON.stringify(data, null, pretty ? 2 : undefined) + "\n";
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;

  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}

/**
 * Create the directory containing `filePath` if it does not exist,
 * write the file atomically, and ensure the directory exists.
 */
export async function writeConfigFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}
