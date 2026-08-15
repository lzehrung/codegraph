import { describe, expect, it } from "vitest";
import { formatPrettyValue } from "../src/cli/pretty.js";

describe("formatPrettyValue", () => {
  it.each([
    { name: "null", value: null, expected: "none" },
    { name: "undefined", value: undefined, expected: "none" },
    { name: "false", value: false, expected: "no" },
    { name: "empty string", value: "", expected: "(empty)" },
    { name: "bigint", value: 10n, expected: "10" },
  ])("formats $name scalars", ({ value, expected }) => {
    expect(formatPrettyValue(value)).toBe(expected);
  });

  it("formats empty record and empty array", () => {
    expect(formatPrettyValue({})).toBe("(none)");
    expect(formatPrettyValue([])).toBe("(none)");
  });

  it("formats nested arrays", () => {
    expect(formatPrettyValue([["a", "b"], ["c"]])).toBe("-\n  - a\n  - b\n-\n  - c");
  });

  it("formats a record without scalar fields", () => {
    expect(formatPrettyValue([{ nested: { ok: true } }])).toBe("-\n  Nested:\n    Ok: yes");
  });
});
