import { describe, expect, it } from "vitest";
import { assessValidationCommand, missingRequiredValidationCommands, supplementalValidationCommands } from "../src/core/validation-policy.js";

describe("validation command policy", () => {
  const required = ["npm test"];

  it("records additional validation without coupling policy to a language or framework", () => {
    expect(assessValidationCommand("npx vitest run tests/flow.test.ts", required)).toMatchObject({ classification: "supplemental" });
    expect(assessValidationCommand("go test ./...", required)).toMatchObject({ classification: "supplemental" });
    expect(supplementalValidationCommands([
      "npm test",
      "npx vitest run tests/flow.test.ts",
      "go test ./..."
    ], required).map((assessment) => assessment.command)).toEqual([
      "npx vitest run tests/flow.test.ts",
      "go test ./..."
    ]);
  });

  it("does not let supplemental evidence replace a required command", () => {
    expect(missingRequiredValidationCommands(required, ["npx vitest run tests/flow.test.ts"])).toEqual(["npm test"]);
  });

  it("normalises whitespace only for matching an approved command", () => {
    expect(assessValidationCommand("  npm   test  ", required)).toMatchObject({ classification: "approved" });
  });
});
