import { describe, expect, it } from "vitest";
import { preserveExistingMcpConfig } from "../src/installer/registry.js";

describe("installer preservation", () => {
  it("preserves an equivalent existing MCP server configuration", () => {
    const existing = { command: "codegraph", args: ["mcp", "--stdio"] };
    const requested = { ...existing, args: [...existing.args] };

    const choice = preserveExistingMcpConfig(existing, requested);

    expect(choice.preserveExisting).toBeTruthy();
    expect(choice.configuration).toBe(existing);
  });

  it("does not treat delimiter-bearing argument sequences as equivalent", () => {
    const existing = { command: "codegraph", args: ["mcp\0--stdio"] };
    const requested = { command: "codegraph", args: ["mcp", "--stdio"] };

    const choice = preserveExistingMcpConfig(existing, requested);

    expect(choice.preserveExisting).toBeFalsy();
    expect(choice.configuration).toBe(requested);
  });
});
