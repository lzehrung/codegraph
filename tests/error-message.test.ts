import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/util/errors.js";

describe("errorMessage", () => {
  it("returns Error.message for Error instances", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage({ code: "EFAIL" })).toBe("[object Object]");
  });
});
