import { describe, expect, it } from "vitest";
import { commitCommands, proposeCommits } from "../src/core/commit-planner.js";

describe("commit planner", () => {
  it("creates one conservative proposal per task", () => {
    const proposals = proposeCommits({ version: 1, tasks: [{ id: "api", objective: "Add campaign-aware API", reads: [], writes: ["api.ts", "api.test.ts"], dependsOn: [], validation: [], status: "completed" }] });
    expect(proposals[0].message).toBe("feat: add campaign-aware API");
    expect(commitCommands(proposals[0])).toHaveLength(2);
  });
});
