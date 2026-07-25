#!/usr/bin/env node
import { readFileSync } from "node:fs";

const [filePath, key] = process.argv.slice(2);
if (!filePath || !key) {
  console.error("Usage: node scripts/json-get.mjs <file|-> <key>");
  process.exit(1);
}

const source = filePath === "-" ? readFileSync(0, "utf8") : readFileSync(filePath, "utf8");
const value = JSON.parse(source)[key];
if (value === undefined || value === null) {
  process.exit(0);
}
process.stdout.write(String(value));
