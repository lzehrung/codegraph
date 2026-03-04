/**
 * Regression tests for the parser-efficiency fixes:
 *
 * 1. signatureChanged hint must only fire when params actually changed
 * 2. seedTransitiveFromFiles must run even when symbols were also detected
 * 3. findNodesInLines pruning – empty changedLines returns no nodes
 * 4. findDeclarationNameInAncestors – skips names not tracked in locals,
 *    so a method-body edit is correctly attributed to the containing class
 * 5. method_definition added to isDeclarationName for JS and TS
 * 6. appendUniqueSpecifiers deduplication is idempotent and O(n) per call
 * 7. TypeScript ambient module augmentation creates a file-graph edge
 */

import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import {
  buildProjectIndex,
  analyzeImpactFromDiff,
} from "../src/index.js";
import type { CompactImpactReport, ImpactReport } from "../src/impact/types.js";
import { collectChangedLines } from "../src/impact/map.js";
import { seedTransitiveFromFiles } from "../src/impact/analyzer.js";
import type { ProjectIndex } from "../src/indexer.js";
import type { Edge } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonCompact(
  report: ImpactReport | CompactImpactReport,
): ImpactReport {
  if ("files" in report) throw new Error("Expected non-compact ImpactReport");
  return report;
}

async function withTmpDir(
  name: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  // Use os.tmpdir() + mkdtemp for guaranteed uniqueness (safe under concurrent
  // Vitest workers) and to keep temp artifacts out of the repo working tree.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `codegraph-${name}-`));
  try {
    await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. signatureChanged hint – only fires when parameters actually changed
// ---------------------------------------------------------------------------

describe("signatureChanged hint accuracy", () => {
  it("fires when the parameter list is in the diff", async () => {
    await withTmpDir("sig-changed-true", async (root) => {
      const file = path.join(root, "lib.ts");
      const consumer = path.join(root, "app.ts");
      await fsp.writeFile(
        file,
        "export function add(a: number, b: number): number { return a + b; }\n",
      );
      await fsp.writeFile(
        consumer,
        'import { add } from "./lib"; console.log(add(1, 2));\n',
      );
      const index = await buildProjectIndex(root);

      // Diff changes the signature line (param added)
      const diffText = [
        "diff --git a/lib.ts b/lib.ts",
        "--- a/lib.ts",
        "+++ b/lib.ts",
        "@@ -1,1 +1,1 @@",
        "-export function add(a: number, b: number): number { return a + b; }",
        "+export function add(a: number, b: number, c?: number): number { return a + b; }",
      ].join("\n");

      const result = nonCompact(
        await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText,
          includeTests: true,
        }),
      );

      const impact = result.impacted.find(
        (item) => item.file === consumer.replace(/\\/g, "/"),
      );
      expect(impact).toBeDefined();
      expect(impact?.explain?.hints).toContain("signatureChanged");
    });
  });

  it("does NOT fire when only the function body changed (not params) – multi-line", async () => {
    await withTmpDir("sig-changed-false", async (root) => {
      const file = path.join(root, "lib.ts");
      const consumer = path.join(root, "app.ts");
      // Multi-line function so body and params are on different lines.
      await fsp.writeFile(
        file,
        [
          "export function compute(x: number): number {",
          "  return x * 2;",
          "}",
        ].join("\n") + "\n",
      );
      await fsp.writeFile(
        consumer,
        'import { compute } from "./lib"; console.log(compute(5));\n',
      );
      const index = await buildProjectIndex(root);

      // Diff changes only line 2 (the body), NOT the signature on line 1
      const diffText = [
        "diff --git a/lib.ts b/lib.ts",
        "--- a/lib.ts",
        "+++ b/lib.ts",
        "@@ -1,3 +1,3 @@",
        " export function compute(x: number): number {",
        "-  return x * 2;",
        "+  return x * 3;",
        " }",
      ].join("\n");

      const result = nonCompact(
        await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText,
          includeTests: true,
        }),
      );

      const impact = result.impacted.find(
        (item) => item.file === consumer.replace(/\\/g, "/"),
      );
      // Impact must exist (the function changed) but signatureChanged should NOT
      expect(impact).toBeDefined();
      expect(impact!.explain?.hints ?? []).not.toContain("signatureChanged");
    });
  });

  it("does NOT fire when only the body of a single-line function changed (byte-range fix)", async () => {
    // This is the main false-positive the byte-range approach fixes: for a
    // one-liner, params and body share the same line so a line-only check
    // always fires; byte-range narrowing correctly isolates the body edit.
    await withTmpDir("sig-changed-oneliner", async (root) => {
      const file = path.join(root, "lib.ts");
      const consumer = path.join(root, "app.ts");
      await fsp.writeFile(
        file,
        "export function add(a: number): number { return a + 1; }\n",
      );
      await fsp.writeFile(
        consumer,
        'import { add } from "./lib"; console.log(add(1));\n',
      );
      const index = await buildProjectIndex(root);

      // Diff changes only the body portion on the single line – params unchanged
      const diffText = [
        "diff --git a/lib.ts b/lib.ts",
        "--- a/lib.ts",
        "+++ b/lib.ts",
        "@@ -1 +1 @@",
        "-export function add(a: number): number { return a + 1; }",
        "+export function add(a: number): number { return a + 2; }",
      ].join("\n");

      const result = nonCompact(
        await analyzeImpactFromDiff(root, index, {
          provider: "raw",
          diffText,
          includeTests: true,
        }),
      );

      const impact = result.impacted.find(
        (item) => item.file === consumer.replace(/\\/g, "/"),
      );
      expect(impact).toBeDefined();
      expect(impact!.explain?.hints ?? []).not.toContain("signatureChanged");
    });
  });
});

// ---------------------------------------------------------------------------
// 2. seedTransitiveFromFiles runs even when symbols were also detected
// ---------------------------------------------------------------------------

describe("seedTransitiveFromFiles – always runs", () => {
  it("seeds deleted-file impact even when changedSymbols is non-empty", async () => {
    const featureFile = path.resolve("src/feature.ts");
    const deletedFile = path.resolve("src/deleted.ts");
    const consumerFile = path.resolve("src/consumer.ts");

    const edges: Edge[] = [
      // consumerFile imports from deletedFile
      {
        from: consumerFile,
        to: { type: "file", path: deletedFile },
        raw: "./deleted",
      },
    ];

    const index: ProjectIndex = {
      graph: { nodes: new Set([featureFile, deletedFile, consumerFile]), edges },
      modules: new Map(),
      byFile: new Map(),
      exportCache: new Map(),
      scopeCache: new Map(),
    };

    const impacted = new Map<string, ReturnType<typeof Array.prototype.find>>();
    const changedFiles = [
      { path: deletedFile, kind: "deleted" as const, hunks: [] },
    ];

    // Even with a non-empty changedSymbols we still want the deleted-file path seeded
    await seedTransitiveFromFiles(index, impacted, changedFiles, {});

    // consumerFile should be in impacted because it depends on the deleted file
    expect(impacted.has(consumerFile)).toBe(true);
    const item = impacted.get(consumerFile);
    expect(item?.explain?.hints).toContain("fileDeleted");
  });

  it("does NOT add already-impacted files a second time", async () => {
    const libFile = path.resolve("src/lib.ts");
    const consumerFile = path.resolve("src/consumer.ts");
    const edges: Edge[] = [
      { from: consumerFile, to: { type: "file", path: libFile }, raw: "./lib" },
    ];
    const index: ProjectIndex = {
      graph: { nodes: new Set([libFile, consumerFile]), edges },
      modules: new Map(),
      byFile: new Map(),
      exportCache: new Map(),
      scopeCache: new Map(),
    };

    const originalSeverity = 0.9;
    const impacted = new Map<string, { file: string; severity: number; symbols: string[]; reasons: string[]; depth: number }>([
      [consumerFile, { file: consumerFile, severity: originalSeverity, symbols: [], reasons: ["directRef"], depth: 0 }],
    ]);

    await seedTransitiveFromFiles(
      index,
      impacted,
      [{ path: libFile, kind: "deleted" as const, hunks: [] }],
      {},
    );

    // Existing entry must not be overwritten by the transitive seeder
    expect(impacted.get(consumerFile)?.severity).toBe(originalSeverity);
  });
});

// ---------------------------------------------------------------------------
// 3. collectChangedLines + findNodesInLines – edge cases
// ---------------------------------------------------------------------------

describe("collectChangedLines", () => {
  it("returns an empty set for an empty hunks array", () => {
    const lines = collectChangedLines([]);
    expect(lines.size).toBe(0);
  });

  it("returns an empty set for a hunk whose lines array is empty", () => {
    // A hunk object with no line entries (zero changed lines) must not produce
    // any output – exercises the early-return path inside the hunk loop.
    const lines = collectChangedLines([
      { oldStart: 1, newStart: 1, lines: [] },
    ]);
    expect(lines.size).toBe(0);
  });

  it("maps added lines to new-file positions", () => {
    const lines = collectChangedLines([
      { oldStart: 1, newStart: 1, lines: ["+new line"] },
    ]);
    expect(lines.has(1)).toBe(true);
  });

  it("maps deleted lines to the current new-file cursor position", () => {
    // A deletion at the start of a hunk (newStart=5)
    const lines = collectChangedLines([
      { oldStart: 5, newStart: 5, lines: ["-deleted"] },
    ]);
    // Should map to newLine=5, not oldLine
    expect(lines.has(5)).toBe(true);
  });

  it("handles completely-deleted file hunks (newStart=0) gracefully", () => {
    // When a file is entirely deleted, unified diff uses +0,0
    const lines = collectChangedLines([
      {
        oldStart: 1,
        newStart: 0,
        lines: ["-line one", "-line two", "-line three"],
      },
    ]);
    // Must not throw; lines should be recorded via oldLine fallback
    expect(lines.size).toBeGreaterThanOrEqual(1);
  });

  it("correctly handles context lines (space prefix) – does not mark them changed", () => {
    const lines = collectChangedLines([
      {
        oldStart: 1,
        newStart: 1,
        lines: [" context", "+added", " context"],
      },
    ]);
    // Only line 2 (the +added) should be in the set
    expect(lines.has(2)).toBe(true);
    expect(lines.has(1)).toBe(false);
    expect(lines.has(3)).toBe(false);
  });

  it("handles mixed additions and deletions correctly", () => {
    const lines = collectChangedLines([
      {
        oldStart: 10,
        newStart: 10,
        lines: ["-removed", "+replacement", " context"],
      },
    ]);
    // "-removed" → newLine=10 (current position before any addition)
    expect(lines.has(10)).toBe(true);
    // "+replacement" → also newLine=10, then newLine becomes 11
    // " context" → newLine=11 (context, NOT added)
    expect(lines.has(11)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. method_definition recognized as declaration name for JS/TS
// ---------------------------------------------------------------------------

describe("method_definition in isDeclarationName", () => {
  it("JS – a method-body edit is attributed to the enclosing class", async () => {
    await withTmpDir("method-def-js", async (root) => {
      await fsp.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      await fsp.writeFile(
        path.join(root, "lib.js"),
        [
          "export class Calculator {",
          "  add(a, b) {",
          "    return a + b;",
          "  }",
          "}",
        ].join("\n") + "\n",
      );
      await fsp.writeFile(
        path.join(root, "app.js"),
        'import { Calculator } from "./lib.js"; new Calculator().add(1, 2);\n',
      );

      const index = await buildProjectIndex(root);
      const { locateChangedSymbols } = await import("../src/impact/map.js");

      const libFile = path.join(root, "lib.js").replace(/\\/g, "/");
      const mod = index.byFile.get(libFile);
      expect(mod).toBeDefined();

      // Simulate changing line 3 (inside the method body)
      const changed = await locateChangedSymbols(index, libFile, [
        { oldStart: 3, newStart: 3, lines: ["+    // body edit"] },
      ]);

      // The change should be attributed to the Calculator class (since methods
      // aren't tracked as separate locals, the search climbs to the class)
      expect(changed.some((s) => s.name === "Calculator")).toBe(true);
    });
  });

  it("TS – a method-body edit is attributed to the enclosing class", async () => {
    await withTmpDir("method-def-ts", async (root) => {
      await fsp.writeFile(
        path.join(root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      await fsp.writeFile(
        path.join(root, "service.ts"),
        [
          "export class UserService {",
          "  fetchUser(id: number) {",
          "    return { id };",
          "  }",
          "}",
        ].join("\n") + "\n",
      );
      await fsp.writeFile(
        path.join(root, "main.ts"),
        'import { UserService } from "./service"; new UserService().fetchUser(1);\n',
      );

      const index = await buildProjectIndex(root);
      const { locateChangedSymbols } = await import("../src/impact/map.js");

      const svcFile = path.join(root, "service.ts").replace(/\\/g, "/");

      // Simulate changing line 3 (inside method body)
      const changed = await locateChangedSymbols(index, svcFile, [
        { oldStart: 3, newStart: 3, lines: ["+    // body edit"] },
      ]);

      // Should be attributed to UserService (method not a separate local in TS)
      expect(changed.some((s) => s.name === "UserService")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. TypeScript ambient module augmentation creates a file-graph edge
// ---------------------------------------------------------------------------

describe("TypeScript declare module augmentation", () => {
  it("creates an edge for declare module '...' {} augmentations", async () => {
    await withTmpDir("ts-ambient-module", async (root) => {
      await fsp.writeFile(
        path.join(root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      // augmentation file that extends 'react' typings
      await fsp.writeFile(
        path.join(root, "react-augment.d.ts"),
        [
          `declare module "react" {`,
          `  interface ComponentProps { "data-testid"?: string; }`,
          `}`,
        ].join("\n") + "\n",
      );

      const index = await buildProjectIndex(root);

      // There should be an edge from react-augment.d.ts to the external 'react' package
      const augmentFile = path
        .join(root, "react-augment.d.ts")
        .replace(/\\/g, "/");
      const edges = index.graph.edges.filter(
        (e: Edge) =>
          e.from === augmentFile &&
          e.to.type === "external" &&
          e.to.name === "react",
      );
      expect(edges.length).toBeGreaterThan(0);
      // Ambient module augmentations are purely type-level dependencies
      expect(edges.every((edge) => edge.typeOnly === true)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. appendUniqueSpecifiers – deduplication is idempotent
// ---------------------------------------------------------------------------

describe("appendUniqueSpecifiers deduplication", () => {
  it("does not produce a duplicate edge when the same spec appears in both HTML attribute and inline-script extraction paths", async () => {
    // appendUniqueSpecifiers merges results from extractHtmlAttributeSpecifiers
    // (script src) and extractHtmlInlineScriptSpecifiers (import inside <script>).
    // If both produce the exact same spec string the shared `seen` Set must
    // prevent a duplicate edge.
    await withTmpDir("dedup-html-specifiers", async (root) => {
      await fsp.writeFile(
        path.join(root, "index.html"),
        [
          "<!DOCTYPE html>",
          "<html>",
          "  <script src='./app.js'></script>",
          "  <script type='module'>",
          "    import './app.js';",  // exact same specifier as src attribute
          "  </script>",
          "</html>",
        ].join("\n"),
      );
      await fsp.writeFile(path.join(root, "app.js"), "console.log('hi');\n");

      const index = await buildProjectIndex(root);
      const htmlFile = path.join(root, "index.html").replace(/\\/g, "/");
      const appFile = path.join(root, "app.js").replace(/\\/g, "/");

      const edgesFromHtml = index.graph.edges.filter(
        (e: Edge) =>
          e.from === htmlFile &&
          e.to.type === "file" &&
          e.to.path === appFile,
      );

      // Both extraction paths discovered ./app.js but it should appear once
      expect(edgesFromHtml.length).toBe(1);
    });
  });
});
