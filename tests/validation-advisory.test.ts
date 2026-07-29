import { describe, expect, it } from "vitest";
import { adviseSupplementalValidation } from "../src/core/validation-advisory.js";
import { defaultConfig } from "../src/config/defaults.js";
import type { StructuredDecisionProvider, StructuredDecisionRequest, StructuredDecisionResult } from "../src/core/structured-decision.js";

describe("supplemental validation advisory", () => {
  it("does not turn an advisory provider failure into a workflow error", async () => {
    const provider: StructuredDecisionProvider = {
      name: "unavailable",
      capabilities: () => ({ structuredOutput: true, schemaEnforcement: true, minimalContext: true, toolIsolation: true }),
      async decide<T = unknown>(_request: StructuredDecisionRequest): Promise<StructuredDecisionResult<T>> { void _request; throw new Error("temporary model outage"); }
    };

    await expect(adviseSupplementalValidation({
      provider,
      root: process.cwd(),
      config: defaultConfig(),
      approvedCommands: ["go test ./..."],
      supplemental: [{ command: "go test ./pkg/example", classification: "supplemental", reason: "Additional evidence." }]
    })).resolves.toMatchObject({ status: "unavailable", advice: [], failureReason: "temporary model outage" });
  });
});
