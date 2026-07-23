import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import type { HarnessAdapter } from "../types.js";
import type { LeanRigorConfig, ModelTier } from "../../config/schema.js";
import { isClaudeAlias, resolveModelTier } from "../../config/models.js";

export class ClaudeAdapter implements HarnessAdapter {
  name = "claude";
  modelResolver = {
    resolve(tier: ModelTier, config: LeanRigorConfig): string | undefined {
      return resolveModelTier(tier, "claude", config).model;
    }
  };

  async install(root: string, config: LeanRigorConfig): Promise<void> {
    const commandDir = path.join(root, ".claude", "commands");
    const agentDir = path.join(root, ".claude", "agents");
    await mkdir(commandDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const triageModel = this.modelResolver.resolve(config.routing.triage, config) ?? "inherit";
    await writeFile(path.join(agentDir, "leanrigor-triage.md"), `---\nname: leanrigor-triage\ndescription: Classify a coding request and recommend fast, standard, or rigorous workflow.\nmodel: ${triageModel}\ntools: Read, Glob, Grep\n---\n\nReturn only valid JSON matching the TriageOutput contract described in skills/triage-task/SKILL.md. Separate complexity from risk, choose the lowest safe mode, request at most one blocking clarification, keep repository inspection narrow, and never modify files.\n`);
    await writeFile(path.join(commandDir, "leanrigor.md"), `Use LeanRigor in this repository. Read PRODUCT.md, ARCHITECTURE.md, .leanrigor/config.json, and relevant skill documents. Triage with the configured small model tier, validate and policy-check its output, run preflight, ask only blocking questions, create a proportional plan, apply review rules by mode, and never commit without confirmation.\n\nRequest: $ARGUMENTS\n`);
    await writeFile(path.join(commandDir, "leanrigor-plan.md"), `Plan only with LeanRigor. Perform bounded triage and repository inspection, then produce an execution graph. Do not modify implementation files.\n\nRequest: $ARGUMENTS\n`);
    await writeFile(path.join(commandDir, "leanrigor-status.md"), `Read .leanrigor/workflow.json and report current mode, phase, decisions, tasks, ownership, validation, and blockers.\n`);
    await writeFile(path.join(commandDir, "leanrigor-commit.md"), `Inspect the completed LeanRigor workflow and git diff. Propose cohesive commit groups and exact commands. Do not commit unless explicitly confirmed.\n`);
  }

  async doctor(root: string, config: LeanRigorConfig): Promise<string[]> {
    const output = ["Platform: Claude Code", `Automatic triage: ${config.workflow.automaticTriage ? "enabled" : "disabled"}`];
    for (const tier of ["small", "medium", "large"] as const) {
      try {
        const resolved = resolveModelTier(tier, "claude", config);
        const detail = resolved.model && isClaudeAlias(resolved.model) ? "Claude alias" : "custom identifier";
        output.push(`${tier[0].toUpperCase() + tier.slice(1)} model: ${resolved.model ?? "inherit"} (${resolved.source}${resolved.model ? `, ${detail}` : ""})`);
      } catch (error) { output.push(`ERROR ${tier}: ${(error as Error).message}`); }
    }
    try { await access(path.join(root, ".claude", "commands", "leanrigor.md")); output.push("Claude command installation: present"); }
    catch { output.push("Claude command installation: missing"); }
    return output;
  }
}
