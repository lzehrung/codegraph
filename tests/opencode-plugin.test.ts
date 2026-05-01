import { describe, expect, it } from "vitest";
import path from "node:path";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import {
  definition,
  graph,
  impact,
  impact_stream,
  overview,
  references,
  grep,
} from "../packages/codegraph-opencode-plugin/src/index.js";

type ToolOutput = {
  status: "ok" | "error";
  source: "library" | "cli";
  root: string;
  result?: unknown;
  error?: string;
};

const parseToolOutput = (value: string): ToolOutput => JSON.parse(value) as ToolOutput;

const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");

const metadataEvents: Array<{ chunk: unknown }> = [];

const context: ToolContext = {
  sessionID: "test-session",
  messageID: "test-message",
  agent: "test-agent",
  directory: samplePath,
  worktree: samplePath,
  abort: new AbortController().signal,
  metadata: (input) => {
    if (input.metadata && "chunk" in input.metadata) {
      metadataEvents.push({ chunk: input.metadata.chunk });
    }
  },
  ask: async () => {},
};

describe("OpenCode plugin tools", () => {
  it("graph returns a JSON envelope with nodes", async () => {
    const output = await graph.execute({ format: "json" }, context);
    const parsed = parseToolOutput(output);
    expect(parsed.status).toBe("ok");

    const graphResult = parsed.result as {
      graph?: { nodes: string[]; edges: unknown[] };
    };
    expect(graphResult.graph).toBeDefined();
    expect(graphResult.graph?.nodes.length).toBeGreaterThan(0);
  });

  it("definition returns a definition result", async () => {
    const mainFile = path.join(samplePath, "main.ts");
    const output = await definition.execute({ file: mainFile, line: 7, column: 25 }, context);
    const parsed = parseToolOutput(output);
    expect(parsed.status).toBe("ok");

    const definitionResult = parsed.result as {
      definition?: { file: string };
    };
    expect(definitionResult.definition?.file).toContain("utils.ts");
  });

  it("references returns at least one reference", async () => {
    const utilsFile = path.join(samplePath, "utils.ts");
    const output = await references.execute({ file: utilsFile, line: 1, column: 17 }, context);
    const parsed = parseToolOutput(output);
    expect(parsed.status).toBe("ok");

    const referencesResult = parsed.result as {
      references?: Array<{ file: string }>;
    };
    expect(referencesResult.references?.length).toBeGreaterThan(0);
  });

  it("overview returns a structured summary string derived from the agent overview contract", async () => {
    const output = await overview.execute({ file: path.join(samplePath, "main.ts") }, context);
    const parsed = parseToolOutput(output);
    expect(parsed.status).toBe("ok");
    expect(typeof parsed.result).toBe("string");
    expect(parsed.result).toContain("# Overview of");
  });

  it("graph can return mermaid output", async () => {
    const output = await graph.execute({ format: "mermaid" }, context);
    const parsed = parseToolOutput(output);
    expect(parsed.status).toBe("ok");
    expect(typeof parsed.result).toBe("string");
    expect((parsed.result as string).trim().length).toBeGreaterThan(0);
  });

  it("impact returns a compact report between revisions", async () => {
    const output = await impact.execute({ base: "HEAD~1", head: "HEAD" }, context);
    const parsed = parseToolOutput(output);
    expect(parsed.status).toBe("ok");

    const impactResult = parsed.result as {
      report?: { schemaVersion?: number; format?: string };
    };
    expect(impactResult.report).toBeDefined();
    expect(impactResult.report?.schemaVersion).toBe(1);
    expect(impactResult.report?.format).toBe("full");
  });

  it("impact_stream emits metadata chunks and returns a summary", async () => {
    metadataEvents.length = 0;
    const output = await impact_stream.execute({ base: "HEAD~1", head: "HEAD" }, context);
    const parsed = parseToolOutput(output);
    expect(parsed.status).toBe("ok");
    expect(metadataEvents.length).toBeGreaterThan(0);

    const streamResult = parsed.result as {
      summary?: { type?: string };
      streamedChunks?: number;
    };
    expect(streamResult.streamedChunks).toBeGreaterThan(0);
  });

  it("grep returns an error when query and pattern are missing", async () => {
    const output = await grep.execute({}, context);
    const parsed = parseToolOutput(output);
    expect(parsed.status).toBe("error");
    expect(parsed.error).toBeDefined();
  });
});
