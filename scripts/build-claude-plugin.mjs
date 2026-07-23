#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("runtime", { recursive: true });

await build({
  entryPoints: ["src/cli/index.ts"],
  outfile: "runtime/leanrigor-cli.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: false,
  banner: {
    js: "import { createRequire as __leanrigorCreateRequire } from 'node:module';\nconst require = __leanrigorCreateRequire(import.meta.url);"
  },
  legalComments: "none"
});

await writeFile("runtime/package.json", JSON.stringify({ type: "module" }, null, 2) + "\n");
