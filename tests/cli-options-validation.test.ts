import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/context.js";
import {
  parseImpactScopeOption,
  parseNonNegativeIntegerOption,
  parseRefContextOption,
  parseSymbolGraphScopeOption,
} from "../src/cli/options.js";

describe("parseIntegerOptionValue strictness", () => {
  it("rejects hex, scientific, and empty integer strings", () => {
    expect(() => parseNonNegativeIntegerOption("0x5", "--depth", 0)).toThrow(/Invalid --depth value "0x5"/);
    expect(() => parseNonNegativeIntegerOption("1e2", "--depth", 0)).toThrow(/Invalid --depth value "1e2"/);
    expect(() => parseNonNegativeIntegerOption("", "--depth", 0)).toThrow(/Invalid --depth value ""/);
  });

  it("accepts plain decimal integers", () => {
    expect(parseNonNegativeIntegerOption("5", "--depth", 0)).toBe(5);
    expect(parseNonNegativeIntegerOption("0", "--depth", 0)).toBe(0);
  });
});

describe("CLI enum option parsers", () => {
  it("validates symbol graph scope values", () => {
    expect(parseSymbolGraphScopeOption("all", "--symbols-detailed-scope")).toBe("all");
    expect(parseSymbolGraphScopeOption(undefined, "--symbols-detailed-scope")).toBeUndefined();
    expect(() => parseSymbolGraphScopeOption("bogus", "--symbols-detailed-scope")).toThrow(
      /Invalid --symbols-detailed-scope value "bogus"/,
    );
  });

  it("validates ref context values", () => {
    expect(parseRefContextOption("block", "--ref-context")).toBe("block");
    expect(() => parseRefContextOption("raw", "--ref-context")).toThrow(/Invalid --ref-context value "raw"/);
    expect(parseImpactScopeOption("imported", "--scope")).toBe("imported");
  });
});

describe("parseCliArgs value-option guard", () => {
  it("does not consume a following flag as a value", () => {
    expect(() => parseCliArgs("graph", ["--threads", "--json"])).toThrow(
      /Missing value for --threads option/,
    );
  });

  it("allows negative decimal values for integer options", () => {
    const parsed = parseCliArgs("hotspots", ["--limit", "-1"]);
    expect(parsed.options.get("--limit")).toEqual(["-1"]);
  });
});
