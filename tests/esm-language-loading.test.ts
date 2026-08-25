import { describe, expect, it } from "vitest";

describe("ESM package entry", () => {
  it("imports codegraph as an ES module", async () => {
    const mod = await import("../src/index.js");
    expect(mod).toBeDefined();
    expect(typeof mod.buildProjectIndex).toBe("function");
  });
});
