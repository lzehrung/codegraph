import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getUnresolvedImports, getHotspots, getApiSurface, SymbolKind } from "../src/index.js";

describe("graph reports", () => {
  const root = "/root";
  const nodes = new Set([`${root}/a.ts`, `${root}/b.ts`]);
  const edges = [
    { from: `${root}/a.ts`, to: { type: "file" as const, path: `${root}/b.ts` }, raw: "./b" },
    { from: `${root}/a.ts`, to: { type: "external" as const, name: "react" }, raw: "react" },
    { from: `${root}/b.ts`, to: { type: "external" as const, name: "react" }, raw: "react" },
  ];
  const graph = { nodes, edges };

  it("should get unresolved imports", () => {
    const unresolved = getUnresolvedImports(graph);
    expect(unresolved.length).toBe(1);
    expect(unresolved[0].name).toBe("react");
    expect(unresolved[0].importers.length).toBe(2);
  });

  it("does not count Node builtins as unresolved imports", () => {
    const graphWithBuiltins = {
      nodes,
      edges: [
        ...edges,
        { from: `${root}/a.ts`, to: { type: "external" as const, name: "node:path" }, raw: "node:path" },
        { from: `${root}/b.ts`, to: { type: "external" as const, name: "fs" }, raw: "node:fs" },
      ],
    };

    const unresolved = getUnresolvedImports(graphWithBuiltins);

    expect(unresolved.map((entry) => entry.name)).toEqual(["react"]);
  });

  it("does not count declared JS package dependencies as unresolved imports", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cg-unresolved-js-"));
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          react: "^19.0.0",
          "@scope/pkg": "^1.0.0",
        },
        devDependencies: {
          vitest: "^3.0.0",
        },
      }),
      "utf8",
    );
    const srcFile = path.join(projectRoot, "src", "app.ts");
    const graphWithPackages = {
      nodes: new Set([srcFile]),
      edges: [
        { from: srcFile, to: { type: "external" as const, name: "react" }, raw: "react/jsx-runtime" },
        { from: srcFile, to: { type: "external" as const, name: "@scope/pkg" }, raw: "@scope/pkg/subpath" },
        { from: srcFile, to: { type: "external" as const, name: "vitest" }, raw: "vitest" },
        { from: srcFile, to: { type: "external" as const, name: "missing-package" }, raw: "missing-package" },
      ],
    };

    const unresolved = getUnresolvedImports(graphWithPackages, { projectRoot });

    expect(unresolved.map((entry) => entry.name)).toEqual(["missing-package"]);
  });

  it("uses package metadata above a scoped project root", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cg-unresolved-scoped-root-"));
    const projectRoot = path.join(repoRoot, "src");
    fs.mkdirSync(projectRoot);
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          react: "^19.0.0",
        },
      }),
      "utf8",
    );
    const srcFile = path.join(projectRoot, "app.ts");
    const graphWithScopedRoot = {
      nodes: new Set([srcFile]),
      edges: [
        { from: srcFile, to: { type: "external" as const, name: "react" }, raw: "react/jsx-runtime" },
        { from: srcFile, to: { type: "external" as const, name: "missing-package" }, raw: "missing-package" },
      ],
    };

    const unresolved = getUnresolvedImports(graphWithScopedRoot, { projectRoot });

    expect(unresolved.map((entry) => entry.name)).toEqual(["missing-package"]);
  });

  it("does not count declared Python, PHP, Rust, Go, and Zig dependencies as unresolved imports", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cg-unresolved-multi-manifest-"));
    fs.writeFileSync(path.join(projectRoot, "requirements.txt"), "requests>=2\nclick==8.1.7\n", "utf8");
    fs.writeFileSync(
      path.join(projectRoot, "pyproject.toml"),
      ["[project]", 'dependencies = ["httpx>=0.28"]'].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectRoot, "composer.json"),
      JSON.stringify({
        require: {
          "vendor/pkg": "^1.0.0",
          php: "^8.2",
          "ext-json": "*",
        },
        "require-dev": {
          "vendor/dev-tool": "^1.0.0",
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectRoot, "Cargo.toml"),
      [
        "[dependencies]",
        'serde-json = "1"',
        "[dev-dependencies]",
        'rstest = "0.24"',
        "[build-dependencies]",
        'cc = "1"',
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectRoot, "go.mod"),
      [
        "module example.com/local/module",
        "",
        "require github.com/acme/pkg v1.2.3",
        "require (",
        "\tgithub.com/block/pkg v0.1.0",
        ")",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectRoot, "build.zig.zon"),
      [
        ".{",
        "    .name = .sample,",
        "    .dependencies = .{",
        "        .known_dep = .{",
        '            .url = "https://example.com/known_dep.tar.gz",',
        "        },",
        "    },",
        "}",
      ].join("\n"),
      "utf8",
    );
    const pythonFile = path.join(projectRoot, "main.py");
    const phpFile = path.join(projectRoot, "index.php");
    const rustFile = path.join(projectRoot, "lib.rs");
    const goFile = path.join(projectRoot, "main.go");
    const zigFile = path.join(projectRoot, "main.zig");
    const graphWithManifests = {
      nodes: new Set([pythonFile, phpFile, rustFile, goFile, zigFile]),
      edges: [
        { from: pythonFile, to: { type: "external" as const, name: "requests" }, raw: "requests" },
        { from: pythonFile, to: { type: "external" as const, name: "click" }, raw: "click" },
        { from: pythonFile, to: { type: "external" as const, name: "httpx" }, raw: "httpx" },
        { from: phpFile, to: { type: "external" as const, name: "vendor/pkg" }, raw: "vendor/pkg" },
        { from: phpFile, to: { type: "external" as const, name: "vendor/dev-tool" }, raw: "vendor/dev-tool" },
        { from: rustFile, to: { type: "external" as const, name: "serde_json" }, raw: "serde_json" },
        { from: rustFile, to: { type: "external" as const, name: "rstest" }, raw: "rstest" },
        { from: rustFile, to: { type: "external" as const, name: "cc" }, raw: "cc" },
        {
          from: goFile,
          to: { type: "external" as const, name: "github.com/acme/pkg/subpackage" },
          raw: "github.com/acme/pkg/subpackage",
        },
        {
          from: goFile,
          to: { type: "external" as const, name: "github.com/block/pkg/subpackage" },
          raw: "github.com/block/pkg/subpackage",
        },
        {
          from: goFile,
          to: { type: "external" as const, name: "example.com/local/module/internal" },
          raw: "example.com/local/module/internal",
        },
        { from: zigFile, to: { type: "external" as const, name: "known_dep" }, raw: "known_dep" },
        { from: pythonFile, to: { type: "external" as const, name: "missing_python" }, raw: "missing_python" },
        { from: phpFile, to: { type: "external" as const, name: "missing/php" }, raw: "missing/php" },
        { from: rustFile, to: { type: "external" as const, name: "missing_crate" }, raw: "missing_crate" },
        {
          from: goFile,
          to: { type: "external" as const, name: "example.com/missing/pkg" },
          raw: "example.com/missing/pkg",
        },
        { from: zigFile, to: { type: "external" as const, name: "missing_zig" }, raw: "missing_zig" },
      ],
    };

    const unresolved = getUnresolvedImports(graphWithManifests, { projectRoot });

    expect(unresolved.map((entry) => entry.name)).toEqual([
      "missing_python",
      "missing/php",
      "missing_crate",
      "example.com/missing/pkg",
      "missing_zig",
    ]);
  });

  it("does not count supported-language stdlib and URL externals as unresolved imports", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cg-unresolved-stdlib-"));
    const graphWithStdlib = {
      nodes: new Set([
        path.join(projectRoot, "main.py"),
        path.join(projectRoot, "main.go"),
        path.join(projectRoot, "lib.rs"),
        path.join(projectRoot, "Main.java"),
        path.join(projectRoot, "Main.kt"),
        path.join(projectRoot, "Program.cs"),
        path.join(projectRoot, "main.swift"),
        path.join(projectRoot, "main.c"),
        path.join(projectRoot, "main.cpp"),
        path.join(projectRoot, "style.css"),
      ]),
      edges: [
        { from: path.join(projectRoot, "main.py"), to: { type: "external" as const, name: "pathlib" }, raw: "pathlib" },
        { from: path.join(projectRoot, "main.go"), to: { type: "external" as const, name: "fmt" }, raw: "fmt" },
        {
          from: path.join(projectRoot, "lib.rs"),
          to: { type: "external" as const, name: "std::collections" },
          raw: "std::collections",
        },
        {
          from: path.join(projectRoot, "Main.java"),
          to: { type: "external" as const, name: "java.util.List" },
          raw: "java.util.List",
        },
        {
          from: path.join(projectRoot, "Main.kt"),
          to: { type: "external" as const, name: "kotlin.collections.List" },
          raw: "kotlin.collections.List",
        },
        {
          from: path.join(projectRoot, "Program.cs"),
          to: { type: "external" as const, name: "System" },
          raw: "System",
        },
        {
          from: path.join(projectRoot, "main.swift"),
          to: { type: "external" as const, name: "Foundation" },
          raw: "Foundation",
        },
        { from: path.join(projectRoot, "main.c"), to: { type: "external" as const, name: "stdio.h" }, raw: "stdio.h" },
        { from: path.join(projectRoot, "main.cpp"), to: { type: "external" as const, name: "vector" }, raw: "vector" },
        {
          from: path.join(projectRoot, "style.css"),
          to: { type: "external" as const, name: "https://example.com/app.css" },
          raw: "https://example.com/app.css",
        },
        {
          from: path.join(projectRoot, "main.py"),
          to: { type: "external" as const, name: "missing_module" },
          raw: "missing_module",
        },
      ],
    };

    const unresolved = getUnresolvedImports(graphWithStdlib, { projectRoot });

    expect(unresolved.map((entry) => entry.name)).toEqual(["missing_module"]);
  });

  it("should get hotspots", () => {
    const hotspots = getHotspots(graph);
    expect(hotspots.length).toBe(2);
    expect(hotspots[0].file).toBe(`${root}/b.ts`);
    expect(hotspots[0].fanIn).toBe(1);
  });

  it("should limit and filter hotspots by include roots", () => {
    const scopedGraph = {
      nodes: new Set([`${root}/src/a.ts`, `${root}/src/b.ts`, `${root}/src/c.ts`, `${root}/tests/spec.ts`]),
      edges: [
        {
          from: `${root}/src/a.ts`,
          to: { type: "file" as const, path: `${root}/src/b.ts` },
          raw: "./b",
        },
        {
          from: `${root}/src/c.ts`,
          to: { type: "file" as const, path: `${root}/src/b.ts` },
          raw: "./b",
        },
        {
          from: `${root}/tests/spec.ts`,
          to: { type: "file" as const, path: `${root}/src/a.ts` },
          raw: "../src/a",
        },
      ],
    };

    const hotspots = getHotspots(scopedGraph, {
      includeRoots: [`${root}/src`],
      limit: 2,
    });

    expect(hotspots).toEqual([
      {
        file: `${root}/src/b.ts`,
        fanIn: 2,
        fanOut: 0,
        score: 4,
      },
      {
        file: `${root}/src/a.ts`,
        fanIn: 0,
        fanOut: 1,
        score: 1,
      },
    ]);
  });

  it("should ignore non-finite hotspot limits", () => {
    expect(getHotspots(graph, { limit: Number.NaN })).toEqual(getHotspots(graph));
    expect(getHotspots(graph, { limit: Number.POSITIVE_INFINITY })).toEqual(getHotspots(graph));
  });

  it("should get API surface", () => {
    const mockIndex = {
      byFile: new Map([
        [
          `${root}/a.ts`,
          {
            file: `${root}/a.ts`,
            exports: [
              {
                type: "local" as const,
                exportedAs: "foo",
                target: { localName: "foo", kind: SymbolKind.Function, range: {}, file: `${root}/a.ts` },
              },
            ],
            imports: [],
            locals: [],
          },
        ],
      ]),
    };
    const api = getApiSurface(mockIndex);
    expect(api.length).toBe(1);
    expect(api[0].file).toBe(`${root}/a.ts`);
    expect(api[0].exports[0].exportedAs).toBe("foo");
  });

  it("should handle complex re-export chains in apisurface", () => {
    const mockIndex = {
      byFile: new Map([
        [
          `${root}/lib.ts`,
          {
            file: `${root}/lib.ts`,
            exports: [
              {
                type: "local",
                exportedAs: "base",
                target: { localName: "base", kind: SymbolKind.Variable, file: `${root}/lib.ts`, range: {} },
              },
            ],
            imports: [],
            locals: [],
          },
        ],
        [
          `${root}/barrel.ts`,
          {
            file: `${root}/barrel.ts`,
            exports: [
              { type: "reexport", exportedAs: "aliased", fromModule: `${root}/lib.ts`, sourceSpecifier: "base" },
              { type: "exportStar", fromModule: `${root}/lib.ts` },
            ],
            imports: [],
            locals: [],
          },
        ],
      ]),
    };
    const api = getApiSurface(mockIndex);
    const barrel = api.find((a) => a.file === `${root}/barrel.ts`);
    expect(barrel).toBeDefined();
    expect(barrel!.exports.some((e) => e.exportedAs === "aliased" && e.kind === "reexport")).toBe(true);
    expect(barrel!.exports.some((e) => e.kind === "exportStar")).toBe(true);
  });
});
