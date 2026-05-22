import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { buildProjectIndex } from "../src/index.js";

async function createFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

describe("Symbols-detailed pruning flags", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scope=imported filters files while still producing edges", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "javascript");
    const index = await buildProjectIndex(root);
    const { buildSymbolGraphDetailed } = await import("../src/graphs.js");
    const sgAll = await buildSymbolGraphDetailed(index, { scope: "all" });
    const sgImported = await buildSymbolGraphDetailed(index, { scope: "imported" });
    // Imported should not exceed all; typically fewer or equal edges
    expect(sgImported.edges.length).toBeLessThanOrEqual(sgAll.edges.length);
  });

  it("maxEdges caps the number of uses edges", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "javascript");
    const index = await buildProjectIndex(root);
    const { buildSymbolGraphDetailed } = await import("../src/graphs.js");
    const cap = 2;
    const sg = await buildSymbolGraphDetailed(index, { maxEdges: cap });
    // Only count 'uses' edges for cap; file/symbol containment edges are not part of this graph
    const usesCount = sg.edges.filter((e) => e.label === "uses").length;
    expect(usesCount).toBeLessThanOrEqual(cap);
  });

  it("membersOnly omits direct alias uses edges", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "javascript");
    const index = await buildProjectIndex(root);
    const { buildSymbolGraphDetailed } = await import("../src/graphs.js");
    const full = await buildSymbolGraphDetailed(index, { membersOnly: false });
    const membersOnly = await buildSymbolGraphDetailed(index, { membersOnly: true });
    // membersOnly should be less than or equal in edges
    expect(membersOnly.edges.length).toBeLessThanOrEqual(full.edges.length);
  });

  it("skips unsupported project files without warning noise", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "javascript");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const index = await buildProjectIndex(root);
    const { buildSymbolGraphDetailed } = await import("../src/graphs.js");

    await buildSymbolGraphDetailed(index, { scope: "all" });

    expect(
      warnSpy.mock.calls.some((call) =>
        call.some((value) => typeof value === "string" && value.includes("Unsupported file extension")),
      ),
    ).toBe(false);
  });

  it("scopes base import edges to requested detailed files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-symbol-scope-"));
    try {
      const aFile = path.join(root, "a.ts");
      const bFile = path.join(root, "b.ts");
      const cFile = path.join(root, "c.ts");
      const aGraphFile = aFile.replace(/\\/g, "/");
      const cGraphFile = cFile.replace(/\\/g, "/");

      await createFile(aFile, 'import { b } from "./b";\nexport function a() { return b(); }\n');
      await createFile(bFile, "export function b() { return 1; }\n");
      await createFile(cFile, 'import { b } from "./b";\nexport function c() { return b(); }\n');

      const index = await buildProjectIndex(root, { keepParsed: true });
      const { buildSymbolGraphDetailed } = await import("../src/graphs.js");
      const graph = await buildSymbolGraphDetailed(index, { files: new Set([aGraphFile]) });

      expect(Array.from(graph.nodes.values()).some((node) => node.file === cGraphFile)).toBe(false);
      expect(graph.edges.some((edge) => edge.from.startsWith(`${cGraphFile}::`))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
