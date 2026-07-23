import { describe, expect, it } from "vitest";
import { FileOwnershipRegistry } from "../src/core/ownership.js";

describe("file ownership", () => {
  it("blocks a second task from acquiring an owned file", () => {
    const registry = new FileOwnershipRegistry();
    registry.acquire("a", ["shared.ts"]);
    expect(() => registry.acquire("b", ["shared.ts"])).toThrow("Files already owned");
  });

  it("releases task leases", () => {
    const registry = new FileOwnershipRegistry();
    registry.acquire("a", ["shared.ts"]);
    registry.release("a");
    expect(() => registry.acquire("b", ["shared.ts"])).not.toThrow();
  });
});
