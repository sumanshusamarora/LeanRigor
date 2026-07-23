import { leanRigorConfigSchema, type LeanRigorConfig } from "./schema.js";
export function defaultConfig(): LeanRigorConfig { return leanRigorConfigSchema.parse({}); }
