import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { chunkSFCFile } from "../../src/chunking/chunk-sfc.js";
import { buildProjectIndex, collectGraph, findReferences, goToDefinition } from "../../src/index.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { prepareSourceInput } from "../../src/languages/file-prep.js";
import { parseSFC } from "../../src/languages/sfc.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { createTestIndexFromFiles } from "../test-utils.js";
import type { ProjectIndex } from "../../src/indexer/types.js";
import {
  __resetNativeTreeSitterBindingForTests,
  __setNativeTreeSitterBindingForTests,
} from "../../src/native/tree-sitter-native.js";
import { loadBinding } from "../../src/native/runtime.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const samplePath = path.join(dirname, "samples", "svelte.sample.svelte");
const source = fs.readFileSync(samplePath, "utf8");

describe("Svelte SFC chunking", () => {
  it("produces script/style/template chunks", () => {
    const chunks = chunkSFCFile({
      source,
      filePath: "svelte.sample.svelte",
      framework: "svelte",
      minTokens: 1,
      maxTokens: 1000,
    });
    expect(chunks.some((c) => c.type?.startsWith("script"))).toBe(true);
    expect(chunks.some((c) => c.type?.startsWith("style"))).toBe(true);
    expect(chunks.some((c) => c.type?.startsWith("template"))).toBe(true);
    const templateChunks = chunks.filter((chunk) => chunk.type?.startsWith("template"));
    expect(templateChunks.every((chunk) => chunk.languageId === "html")).toBe(true);
  });

  it("keeps style imports and reuses a projection failure for an oversized script", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cg-svelte-projection-"));
    const cacheDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cg-svelte-projection-cache-"));
    const styleTargets = (index: ProjectIndex): string[] =>
      index.graph.edges
        .filter((edge) => path.basename(edge.from) === "Deep.svelte")
        .flatMap((edge) => (edge.to.type === "file" ? [path.basename(edge.to.path)] : []))
        .sort();
    try {
      const script = `const x = ${"[".repeat(600)}0${"]".repeat(600)};`;
      const file = path.join(root, "Deep.svelte");
      const component = `<script>\n${script}\n</script>\n<style>\n@import "./x.css";\n</style>\n`;
      await fs.promises.writeFile(file, component);
      await fs.promises.writeFile(path.join(root, "x.css"), "h1 { color: red; }\n");
      const options = { cache: "disk" as const, cacheDir, threads: 1, useNativeWorkers: false };
      const cold = await buildProjectIndex(root, options);
      const warm = await buildProjectIndex(root, options);
      const svelte = [...cold.byFile.values()].find((mod) => path.basename(mod.file) === "Deep.svelte");
      expect(svelte?.syntaxTreeUnavailableReason).toContain("syntax tree projection exceeded max");
      expect(svelte?.syntaxTreeUnavailableFingerprint).toBe(createHash("sha256").update(component).digest("hex"));
      expect(styleTargets(cold)).toContain("x.css");
      expect(styleTargets(warm)).toEqual(styleTargets(cold));

      const state = loadBinding();
      if (!state.loaded || !state.binding.parseSyntaxTree) throw new Error("Native syntax parser required");
      const parse = state.binding.parseSyntaxTree;
      let projections = 0;
      __setNativeTreeSitterBindingForTests({
        ...state,
        binding: {
          ...state.binding,
          parseSyntaxTree: (text, language) => {
            projections += 1;
            return parse(text, language);
          },
        },
      });
      const result = await goToDefinition(warm, { file, line: 2, column: 7 });
      expect(result).toMatchObject({ status: "not_found", reason: expect.stringContaining("projection exceeded") });
      expect(projections).toBe(0);
      await fs.promises.utimes(file, 0, 0);
      const fileKey = fileIdentityKey(file);
      const reads = vi.spyOn(fs, "readFileSync");
      try {
        for (let query = 0; query < 2; query += 1) {
          expect(await goToDefinition(warm, { file, line: 2, column: 7 })).toMatchObject({
            status: "not_found",
            reason: expect.stringContaining("projection exceeded"),
          });
        }
        const readsOfFile = reads.mock.calls.filter(
          ([candidate]) => typeof candidate === "string" && fileIdentityKey(candidate) === fileKey,
        );
        expect(readsOfFile).toHaveLength(1);
      } finally {
        reads.mockRestore();
      }
      expect(projections).toBe(0);
      __resetNativeTreeSitterBindingForTests();
      await fs.promises.writeFile(path.join(root, "y.css"), "h1 { color: blue; }\n");
      await fs.promises.writeFile(file, component.replace("./x.css", "./y.css"));
      await fs.promises.utimes(file, 2, 2);
      await expect(goToDefinition(warm, { file, line: 2, column: 7 })).rejects.toMatchObject({
        name: "StaleQuerySourceError",
      });
      const rebuilt = await buildProjectIndex(root, options);
      expect(styleTargets(rebuilt)).toContain("y.css");
      expect(styleTargets(rebuilt)).not.toContain("x.css");
    } finally {
      __resetNativeTreeSitterBindingForTests();
      await fs.promises.rm(root, { recursive: true, force: true });
      await fs.promises.rm(cacheDir, { recursive: true, force: true });
    }
  });
});

it("keeps forward aliases after adjacent signatures in a Svelte TypeScript script", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cg-svelte-forward-alias-"));
  const file = path.join(root, "Forward.svelte");
  const source = [
    '<script lang="ts">',
    "interface Handler {",
    "  <T0>(): Forward<T0>",
    "  <T1>(): Forward<T1>",
    "  <T2>(): Forward<T2>",
    "}",
    "type Forward<T> = T",
    "const fwd: Forward<string> = 'ok'",
    "</script>",
    "<div>{fwd}</div>",
    "",
  ].join("\n");
  await fs.promises.writeFile(file, source);
  try {
    const index = await createTestIndexFromFiles(root, [file]);
    const goto = await goToDefinition(index, { file, line: 3, column: source.split("\n")[2]!.indexOf("Forward") + 1 });
    expect(goto.status).toBe("ok");
    if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(7);
    const refs = await findReferences(index, { file, line: 7, column: 6 });
    expect(refs.status).toBe("ok");
    if (refs.status === "ok") {
      expect(refs.references.map((reference) => reference.range.start.line)).toEqual([3, 4, 5, 7, 8]);
      expect(refs.referenceCoverage.state).toBe("complete");
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

const definition: LanguageTestDefinition = {
  id: "svelte",
  parity: {
    sampleDir: "svelte",
    exact: {
      dependencyGraph: [
        {
          from: "App.svelte",
          to: { type: "file", path: "logic.ts" },
        },
        {
          from: "App.svelte",
          to: { type: "file", path: "Widget.svelte" },
        },
        {
          from: "ExternalScripts.svelte",
          to: { type: "external", name: "./missing.ts" },
        },
        {
          from: "ExternalScripts.svelte",
          to: { type: "external", name: "https://cdn.example/svelte-helper.js" },
        },
        {
          from: "ExternalScripts.svelte",
          to: { type: "file", path: "extra.ts" },
        },
        {
          from: "ExternalScripts.svelte",
          to: { type: "file", path: "logic.ts" },
        },
        {
          from: "inline-script.svelte",
          to: { type: "file", path: "logic.ts" },
        },
        {
          from: "reactive.svelte",
          to: { type: "file", path: "logic.ts" },
        },
        {
          from: "TypeScriptWidget.svelte",
          to: { type: "file", path: "logic.ts" },
        },
        {
          from: "TypeScriptWidget.svelte",
          to: { type: "file", path: "Widget.svelte" },
        },
        {
          from: "Widget.svelte",
          to: { type: "external", name: "./missing.ts" },
        },
      ],
      references: [
        {
          name: "find references is not available",
          file: "App.svelte",
          line: 3,
          column: 19,
          expectedStatus: "not_found",
        },
      ],
    },
    goToDefinition: [
      {
        name: "go to definition is not available",
        file: "App.svelte",
        line: 3,
        column: 19,
        expectedStatus: "not_found",
      },
    ],
    absentDependencyGraph: [
      {
        from: "ExternalScripts.svelte",
        to: { type: "external", name: "" },
      },
      {
        from: "ExternalScripts.svelte",
        to: { type: "file", path: "missing.ts" },
      },
    ],
  },
};

runLanguageTests(definition);

it("deduplicates and filters Svelte external script src dependencies", async () => {
  const sampleDir = path.resolve(process.cwd(), "tests", "samples", "svelte");
  const sourceFile = path.join(sampleDir, "ExternalScripts.svelte").replace(/\\/g, "/");
  const logicFile = path.join(sampleDir, "logic.ts").replace(/\\/g, "/");
  const extraFile = path.join(sampleDir, "extra.ts").replace(/\\/g, "/");
  const graph = await collectGraph(sampleDir, [sourceFile, logicFile, extraFile]);

  expect(
    graph.edges.filter((edge) => edge.from === sourceFile && edge.to.type === "file" && edge.to.path === logicFile),
  ).toHaveLength(1);
  expect(
    graph.edges.filter((edge) => edge.from === sourceFile && edge.to.type === "file" && edge.to.path === extraFile),
  ).toHaveLength(1);
  expect(
    graph.edges.filter(
      (edge) =>
        edge.from === sourceFile &&
        edge.to.type === "external" &&
        edge.to.name === "https://cdn.example/svelte-helper.js",
    ),
  ).toHaveLength(1);
  expect(
    graph.edges.filter(
      (edge) => edge.from === sourceFile && edge.to.type === "external" && edge.to.name === "./missing.ts",
    ),
  ).toHaveLength(1);
  expect(
    graph.edges.some((edge) => edge.from === sourceFile && edge.to.type === "external" && edge.to.name === ""),
  ).toBe(false);
});

it("applies dynamic import heuristic adapters inside Svelte script blocks", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cg-svelte-dynamic-import-"));
  const sourceFile = path.join(root, "Loader.svelte");
  const targetFile = path.join(root, "target.ts");
  await Promise.all([
    fs.promises.writeFile(
      sourceFile,
      '<script>\nconst target = import(path.join(__dirname, "target"));\n</script>\n',
      "utf8",
    ),
    fs.promises.writeFile(targetFile, "export const value = 1;\n", "utf8"),
  ]);

  try {
    const normalizedSource = sourceFile.replace(/\\/g, "/");
    const normalizedTarget = targetFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [sourceFile, targetFile], {
      dynamicImportHeuristics: true,
    });

    expect(graph.edges).toContainEqual({
      from: normalizedSource,
      to: { type: "file", path: normalizedTarget },
      raw: "./target",
      resolved: "heuristic",
      confidence: 0.7,
    });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

it("classifies a type-only import inside a Svelte script block", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cg-svelte-type-only-"));
  const sourceFile = path.join(root, "Widget.svelte");
  const typesFile = path.join(root, "types.ts");
  const runtimeFile = path.join(root, "runtime.ts");
  await Promise.all([
    fs.promises.writeFile(
      sourceFile,
      '<script>\nimport type { Shape } from "./types";\nimport { runtime } from "./runtime";\n</script>\n',
      "utf8",
    ),
    fs.promises.writeFile(typesFile, "export interface Shape { size: number }\n", "utf8"),
    fs.promises.writeFile(runtimeFile, "export const runtime = 1;\n", "utf8"),
  ]);

  try {
    const index = await createTestIndexFromFiles(root, [sourceFile, typesFile, runtimeFile]);
    // The embedded script statement reaches the JS-family hook, so the statement-level
    // `import type` clause is type-only while the sibling runtime import is not.
    expect(
      index.graph.edges
        .filter((edge) => edge.typeOnly && fileIdentityKey(edge.from) === fileIdentityKey(sourceFile))
        .map((edge) => (edge.to.type === "file" ? edge.to.path : edge.to.name)),
    ).toEqual([typesFile.replace(/\\/g, "/")]);
    const module = index.byFile.get(fileIdentityKey(sourceFile));
    expect((module?.imports ?? []).filter((binding) => binding.typeOnly)).toEqual([
      expect.objectContaining({ from: "./types", typeOnly: true }),
    ]);
    expect((module?.imports ?? []).filter((binding) => binding.from === "./runtime")).toEqual([
      expect.objectContaining({ from: "./runtime", typeOnly: false }),
    ]);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

it("preserves Svelte block content and original coordinates while extracting embedded dependencies", async () => {
  const sampleDir = path.resolve(process.cwd(), "tests", "samples", "svelte");
  const sourceFile = path.join(sampleDir, "sfc-blocks.svelte").replace(/\\/g, "/");
  const source = fs.readFileSync(sourceFile, "utf8");
  const scriptFile = path.join(sampleDir, "sfc-block-script.ts").replace(/\\/g, "/");
  const styleFile = path.join(sampleDir, "sfc-block-theme.scss").replace(/\\/g, "/");
  const templateFile = path.join(sampleDir, "sfc-block-target.html").replace(/\\/g, "/");

  const script = parseSFC(source).find((block) => block.type === "script");
  expect(script).toMatchObject({ startLine: 1, endLine: 5 });
  expect(script?.content).toContain("<!-- </script> -->");
  expect(script?.content).toContain('const embeddedClose = "</script>";');
  expect(script?.content).toContain('import { scriptValue } from "./sfc-block-script.ts";');

  const prepared = await prepareSourceInput(sourceFile, { source });
  const templateBlock = prepared.embeddedBlocks?.find((block) => block.sup.id === "html");
  const styleBlock = prepared.embeddedBlocks?.find((block) => block.sup.id === "scss");
  expect(templateBlock).toBeDefined();
  expect(styleBlock).toBeDefined();
  expect(lineAndColumnAt(source, templateBlock!.block.startOffset)).toEqual({ line: 6, column: 10 });
  expect(lineAndColumnAt(source, styleBlock!.block.startOffset)).toEqual({ line: 10, column: 20 });

  const templateOffset = templateBlock!.source.indexOf("./sfc-block-target.html");
  const styleOffset = styleBlock!.source.indexOf("@import");
  expect(templateOffset).toBe(source.indexOf("./sfc-block-target.html"));
  expect(styleOffset).toBe(source.indexOf("@import"));
  expect(lineAndColumnAt(templateBlock!.source, templateOffset)).toEqual({ line: 8, column: 10 });
  expect(lineAndColumnAt(styleBlock!.source, styleOffset)).toEqual({ line: 11, column: 3 });

  const graph = await collectGraph(sampleDir, [sourceFile, scriptFile, styleFile, templateFile]);
  const localTargets = graph.edges
    .filter((edge) => edge.from === sourceFile)
    .flatMap((edge) => (edge.to.type === "file" ? [edge.to.path] : []))
    .filter((target) => target === scriptFile || target === styleFile || target === templateFile)
    .sort();
  expect(localTargets).toEqual([scriptFile, styleFile, templateFile].sort());
  const index = await createTestIndexFromFiles(sampleDir, [sourceFile, scriptFile, styleFile, templateFile]);
  const indexedTargets = (index.byFile.get(fileIdentityKey(sourceFile))?.imports ?? [])
    .flatMap((entry) => (typeof entry.resolved === "string" ? [entry.resolved] : []))
    .filter((target) => target === scriptFile || target === styleFile || target === templateFile)
    .sort();
  expect(indexedTargets).toEqual([scriptFile, styleFile, templateFile].sort());
});

it("extracts the full outer template block when templates nest", () => {
  const source = '<template><template v-if="ok"><span/></template><p/></template>';
  const blocks = parseSFC(source);
  expect(blocks).toHaveLength(1);
  const template = blocks[0];
  expect(template?.type).toBe("template");
  expect(template?.content).toBe('<template v-if="ok"><span/></template><p/>');
  expect(template?.blockEnd).toBe(source.length);
});

it("stops at the first unmatched opening tag instead of reclassifying nested content as top-level blocks", () => {
  expect(parseSFC("<template><script>const x = 1;</script>")).toEqual([]);
  const blocks = parseSFC("<style>h1 { color: red; }</style><template><p>oops");
  expect(blocks.map((block) => block.type)).toEqual(["style"]);
});

function lineAndColumnAt(source: string, offset: number): { line: number; column: number } {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return {
    line: source.slice(0, offset).split("\n").length,
    column: offset - lineStart + 1,
  };
}
