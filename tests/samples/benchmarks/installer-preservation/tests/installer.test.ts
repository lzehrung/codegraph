import { describe, expect, it } from "vitest";
import { preserveExistingMcpConfig } from "../src/installer/registry.js";

describe("installer preservation", () => {
  it("preserves an equivalent existing MCP server configuration", () => {
    const existing = { command: "codegraph", args: ["mcp", "--stdio"] };

    expect(preserveExistingMcpConfig(existing, { ...existing, args: [...existing.args] })).toEqual({
      preserveExisting: true,
      configuration: existing,
    });
  });
});
