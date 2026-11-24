import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProjectIndex, findReferences, goToDefinition } from "../src/index.js";
import { findRenameReferences, findUsageReferences } from "../src/indexer/navigation.js";
import { createAgentSession } from "../src/agent/session.js";
import { previewRenameInSnapshot } from "../src/agent/rename-preview.js";
import { createCodegraphMcpHandlers, createCodegraphMcpProtocolServer } from "../src/mcp/server.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { captureCli } from "./helpers/cli.js";

const unavailable = {
  status: "not_found",
  reason: "Reference collection is unavailable for non-code targets",
};
const source = [
  'import data from "./data.json";',
  "export const value = data;",
  'import { a } from "./data.json";',
  "export const named = a;",
  'const required = require("./data.json");',
  "export const loaded = required;",
  "function shadow(data: { a: number }) { return data.a; }",
  'export const literal = "data";',
  'import { regular } from "./ordinary";',
  "export const keep = regular;",
  "",
].join("\n");
const positions = [
  { file: "data.json", line: 1, column: 1 },
  { file: "data.json", line: 2, column: 4 },
  { file: "entry.ts", line: 1, column: 8 },
  { file: "entry.ts", line: 2, column: 22 },
  { file: "script.js", line: 1, column: 8 },
  { file: "script.js", line: 2, column: 22 },
  { file: "entry.ts", line: 5, column: 7 },
  { file: "entry.ts", line: 6, column: 23 },
];
const unsupportedPositions = [
  { file: "entry.ts", line: 3, column: 10 },
  { file: "entry.ts", line: 4, column: 22 },
  { file: "config.jsonc", line: 1, column: 1 },
  { file: "tsconfig.json", line: 1, column: 1 },
];

describe("references of non-code module targets", () => {
  let root: string;
  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-json-references-"));
    await Promise.all([
      fsp.writeFile(path.join(root, "entry.ts"), source),
      fsp.writeFile(path.join(root, "script.js"), 'import data from "./data.json";\nexport const value = data;\n'),
      fsp.writeFile(path.join(root, "ordinary.ts"), "export const regular = 1;\n"),
      fsp.writeFile(path.join(root, "data.json"), '{\n  "a": 1\n}\n'),
      fsp.writeFile(path.join(root, "config.jsonc"), '{ /* config */ "a": 1 }\n'),
      fsp.writeFile(path.join(root, "tsconfig.json"), '{"compilerOptions":{"resolveJsonModule":true}}\n'),
      ...["vue", "svelte"].map((extension) =>
        fsp.writeFile(
          path.join(root, `component.${extension}`),
          '<script lang="ts">\nconst item = 1;\nconst value = item;\n</script>\n',
        ),
      ),
    ]);
  });
  afterAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("returns not_found without parsing synthetic targets, cold and warm", async () => {
    for (const cache of ["off", "memory"] as const) {
      for (let round = 0; round < 2; round++) {
        const index = await buildProjectIndex(root, { cache, threads: 1 });
        const module = index.byFile.get(fileIdentityKey(path.join(root, "data.json")));
        const definition = module?.locals[0];
        if (!definition) throw new Error("Expected synthetic JSON default export");
        expect(await findReferences(index, { def: definition })).toEqual(unavailable);
        expect(await findUsageReferences(index, { def: definition })).toEqual(unavailable);
        expect(await findRenameReferences(index, definition)).toEqual(unavailable);
        for (const position of positions) {
          expect(await findReferences(index, { ...position, file: path.join(root, position.file) })).toEqual(
            unavailable,
          );
        }
        for (const position of unsupportedPositions) {
          expect(await findReferences(index, { ...position, file: path.join(root, position.file) })).toMatchObject({
            status: "not_found",
            reason: expect.any(String),
          });
        }
        expect(await goToDefinition(index, { file: path.join(root, "entry.ts"), line: 2, column: 22 })).toMatchObject({
          status: "ok",
          definition: { kind: "default", file: definition.file },
        });
      }
    }
  });

  it.each(["vue", "svelte"])("keeps SFC reference collection available for .%s files", async (extension) => {
    const index = await buildProjectIndex(root, { cache: "off", threads: 1 });
    const file = path.join(root, `component.${extension}`);
    for (const [line, column] of [
      [2, 7],
      [3, 15],
    ] as const) {
      const refs = await findReferences(index, { file, line, column });
      expect(refs).toMatchObject({
        status: "ok",
        definition: { localName: "item" },
        referenceCoverage: { state: "complete" },
      });
      if (refs.status !== "ok") throw new Error("Expected SFC references");
      expect(refs.references.map((ref) => [path.basename(ref.file), ref.range.start.line])).toEqual([
        [`component.${extension}`, 2],
        [`component.${extension}`, 3],
      ]);
    }
  });

  it("keeps references and rename previews of neighboring code targets unchanged", async () => {
    const session = createAgentSession({ root, buildOptions: { cache: "off", threads: 1 } });
    try {
      const snapshot = await session.loadProject();
      const refs = await findReferences(snapshot.index, { file: path.join(root, "ordinary.ts"), line: 1, column: 14 });
      expect(refs).toMatchObject({ status: "ok", referenceCoverage: { state: "complete" } });
      if (refs.status !== "ok") throw new Error("Expected ordinary code references");
      expect(refs.references.map((ref) => [path.basename(ref.file), ref.range.start.line])).toEqual([
        ["entry.ts", 9],
        ["entry.ts", 10],
        ["ordinary.ts", 1],
      ]);
      const preview = await previewRenameInSnapshot(snapshot, {
        root,
        handle: "ordinary.ts::regular",
        newName: "renamed",
      });
      expect(preview.safe).toBe(true);
      expect(preview.edits.map((edit) => [edit.file, edit.range.start.line])).toEqual([
        ["entry.ts", 9],
        ["entry.ts", 10],
        ["ordinary.ts", 1],
      ]);
    } finally {
      session.invalidate();
    }
  });

  it("keeps JSON-target rename previews unsafe without parser errors", async () => {
    const session = createAgentSession({ root, buildOptions: { cache: "off", threads: 1 } });
    try {
      const snapshot = await session.loadProject();
      const preview = await previewRenameInSnapshot(snapshot, {
        root,
        handle: "data.json::default",
        newName: "renamed",
      });
      expect(preview.safe).toBe(false);
      expect(preview.unsafeSites).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reason: "unresolved_reference",
            provenance: expect.objectContaining({ reason: unavailable.reason }),
          }),
        ]),
      );
    } finally {
      session.invalidate();
    }
  });

  it("prints a structured not_found on both CLI output surfaces", async () => {
    const targets = [
      ...positions.map(({ file, line, column }) => `${file}:${line}:${column}`),
      "data.json::default",
      "symbol:data.json:default:1:1",
      ...unsupportedPositions.map(({ file, line, column }) => `${file}:${line}:${column}`),
    ];
    for (const target of targets) {
      for (const json of [false, true]) {
        const flags = json ? ["--json"] : [];
        const result = await captureCli(["refs", target, "--root", root, ...flags]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).not.toContain("Unsupported file extension");
        if (json) {
          expect(JSON.parse(result.stdout)).toMatchObject({ status: "not_found", reason: expect.any(String) });
        } else {
          expect(result.stdout).toContain("not_found:");
        }
      }
    }
  });

  it("returns normal MCP tool results rather than execution errors", async () => {
    const handlers = createCodegraphMcpHandlers({ root });
    const server = createCodegraphMcpProtocolServer(handlers);
    const client = new Client({ name: "json-references-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const requests = [
        ...positions,
        { handle: "data.json::default" },
        { handle: "symbol:data.json:default:1:1" },
        ...unsupportedPositions,
      ];
      for (const request of requests) {
        const result = await client.callTool({ name: "refs", arguments: request });
        expect(result.isError).not.toBe(true);
        const first = result.content[0];
        if (first?.type !== "text") throw new Error("Expected MCP text result");
        const body = JSON.parse(first.text);
        expect(body).toMatchObject({ references: [], totalSeen: 0, truncated: false, omitted: 0 });
      }
    } finally {
      await client.close();
      await server.close();
      handlers.dispose();
    }
  });
});
