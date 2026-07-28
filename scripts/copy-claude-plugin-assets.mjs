import { cp } from "node:fs/promises";

await cp("src/adapters/claude/plugin", "dist/adapters/claude/plugin", { recursive: true });
