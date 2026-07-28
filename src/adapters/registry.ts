import { ClaudeAdapter } from "./claude/adapter.js";
import { ClaudeCliPlanningProvider } from "./claude/planning-provider.js";
import { ClaudeCliTriageProvider } from "./claude/triage-provider.js";
import type { AdapterRuntime } from "./types.js";
import { ClaudeCliExecutionProvider } from "../core/execution/claude-provider.js";

const runtimes = new Map<string, AdapterRuntime>();

export function registerAdapter(runtime: AdapterRuntime): void {
  if (runtimes.has(runtime.id)) throw new Error(`Adapter '${runtime.id}' is already registered.`);
  runtimes.set(runtime.id, runtime);
}

export function getAdapterRuntime(id: string): AdapterRuntime {
  const runtime = runtimes.get(id);
  if (!runtime) throw new Error(`Unsupported adapter: ${id}. Available adapters: ${availableAdapterIds().join(", ") || "(none)"}.`);
  return runtime;
}

export function availableAdapterIds(): string[] {
  return [...runtimes.keys()].sort();
}

registerAdapter({
  id: "claude",
  adapter: new ClaudeAdapter(),
  createTriageProvider: () => new ClaudeCliTriageProvider(),
  createPlanningProvider: () => new ClaudeCliPlanningProvider(),
  createExecutionProvider: (config) => new ClaudeCliExecutionProvider({ config })
});
