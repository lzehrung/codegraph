import { afterEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getUnresolvedImports, getHotspots, getApiSurface, SymbolKind } from "../src/index.js";
import { getExternalClassifierCacheStats, resetExternalClassifierCaches } from "../src/graphs/external-classifier.js";

describe("graph reports", () => {
  const tempRoots: string[] = [];
  const makeTempRoot = (prefix: string): string => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempRoots.push(tempRoot);
    return tempRoot;
  };
  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  const makeBasicGraph = () => {
    const root = makeTempRoot("cg-graph-report-basic-");
    fs.writeFileSync(path.join(root, ".git"), "gitdir: .git\n", "utf8");
    const nodes = new Set([path.join(root, "a.ts"), path.join(root, "b.ts")]);
    const edges = [
      { from: path.join(root, "a.ts"), to: { type: "file" as const, path: path.join(root, "b.ts") }, raw: "./b" },
      { from: path.join(root, "a.ts"), to: { type: "external" as const, name: "react" }, raw: "react" },
      { from: path.join(root, "b.ts"), to: { type: "external" as const, name: "react" }, raw: "react" },
    ];
    return { root, nodes, edges, graph: { nodes, edges } };
  };

  it("should get unresolved imports", () => {
    const { graph } = makeBasicGraph();
    const unresolved = getUnresolvedImports(graph);
    expect(unresolved.length).toBe(1);
    expect(unresolved[0].name).toBe("react");
    expect(unresolved[0].importers.length).toBe(2);
  });

  it("does not count Node builtins as unresolved imports", () => {
    const { nodes, edges } = makeBasicGraph();
    const graphWithBuiltins = {
      nodes,
      edges: [
        ...edges,
        {
          from: [...nodes][0],
          to: { type: "external" as const, name: "node:path" },
          raw: "node:path",
        },
        {
          from: [...nodes][1],
          to: { type: "external" as const, name: "fs" },
          raw: "node:fs",
        },
      ],
    };

    const unresolved = getUnresolvedImports(graphWithBuiltins);

    expect(unresolved.map((entry) => entry.name)).toEqual(["react"]);
  });

  it("does not count declared JS package dependencies as unresolved imports", () => {
    const projectRoot = makeTempRoot("cg-unresolved-js-");
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
    const repoRoot = makeTempRoot("cg-unresolved-scoped-root-");
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

  it("does not read dependency manifests beyond the nearest project manifest boundary", () => {
    const repoRoot = makeTempRoot("cg-unresolved-boundary-");
    const childRoot = path.join(repoRoot, "child");
    const projectRoot = path.join(childRoot, "src");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          "parent-only-package": "^1.0.0",
        },
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(childRoot, "package.json"), JSON.stringify({ name: "child" }), "utf8");
    const srcFile = path.join(projectRoot, "app.ts");
    const graphWithParentOnlyPackage = {
      nodes: new Set([srcFile]),
      edges: [
        { from: srcFile, to: { type: "external" as const, name: "parent-only-package" }, raw: "parent-only-package" },
      ],
    };

    const unresolved = getUnresolvedImports(graphWithParentOnlyPackage, { projectRoot });

    expect(unresolved.map((entry) => entry.name)).toEqual(["parent-only-package"]);
  });

  it("does not read dependency manifests outside the nearest git boundary", () => {
    const outerRoot = makeTempRoot("cg-unresolved-git-boundary-");
    const repoRoot = path.join(outerRoot, "repo");
    const projectRoot = path.join(repoRoot, "src");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".git"), "gitdir: ../.git/worktrees/repo\n", "utf8");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(outerRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          "outside-git-package": "^1.0.0",
        },
      }),
      "utf8",
    );
    const srcFile = path.join(projectRoot, "app.ts");
    const graphWithOuterPackage = {
      nodes: new Set([srcFile]),
      edges: [
        { from: srcFile, to: { type: "external" as const, name: "outside-git-package" }, raw: "outside-git-package" },
      ],
    };

    const unresolved = getUnresolvedImports(graphWithOuterPackage, { projectRoot });

    expect(unresolved.map((entry) => entry.name)).toEqual(["outside-git-package"]);
  });

  it("does not count declared supported-language package dependencies as unresolved imports", () => {
    const projectRoot = makeTempRoot("cg-unresolved-multi-manifest-");
    fs.writeFileSync(path.join(projectRoot, "requirements.txt"), "requests>=2\nclick==8.1.7\n", "utf8");
    fs.writeFileSync(path.join(projectRoot, "requirements.in"), "rich>=13\n", "utf8");
    fs.writeFileSync(
      path.join(projectRoot, "pyproject.toml"),
      [
        "[project]",
        'dependencies = ["httpx>=0.28"]',
        "[tool.poetry.dependencies]",
        'python = "^3.11"',
        'pydantic = "^2.0"',
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(path.join(projectRoot, "setup.cfg"), "[options]\ninstall_requires =\n    attrs>=23\n", "utf8");
    fs.writeFileSync(
      path.join(projectRoot, "Pipfile"),
      ["[packages]", 'pendulum = "*"', "[dev-packages]", 'pytest = "*"'].join("\n"),
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
        '        ."foo-bar" = .{',
        '            .url = "https://example.com/foo-bar.tar.gz",',
        "        },",
        "    },",
        "}",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectRoot, "Gemfile"),
      ['source "https://rubygems.org"', 'gem "rails"', "gem 'sidekiq'"].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectRoot, "sample.gemspec"),
      [
        "Gem::Specification.new do |spec|",
        '  spec.add_dependency "rack"',
        "  spec.add_development_dependency 'rspec'",
        "end",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectRoot, "pom.xml"),
      [
        "<project><dependencies><dependency>",
        "<groupId>org.slf4j</groupId>",
        "<artifactId>slf4j-api</artifactId>",
        "</dependency></dependencies></project>",
      ].join(""),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectRoot, "build.gradle"),
      ["dependencies {", '  implementation "com.google.guava:guava:33.0.0-jre"', "}"].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectRoot, "App.csproj"),
      '<Project><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /></ItemGroup></Project>',
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectRoot, "vcpkg.json"),
      JSON.stringify({ dependencies: ["fmt", { name: "boost-filesystem" }] }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectRoot, "Package.swift"),
      [
        "let package = Package(",
        '  dependencies: [.package(name: "Alamofire", url: "https://example.com/alamofire.git", from: "5.0.0")]',
        ")",
      ].join("\n"),
      "utf8",
    );
    const pythonFile = path.join(projectRoot, "main.py");
    const phpFile = path.join(projectRoot, "index.php");
    const rustFile = path.join(projectRoot, "lib.rs");
    const goFile = path.join(projectRoot, "main.go");
    const zigFile = path.join(projectRoot, "main.zig");
    const rubyFile = path.join(projectRoot, "main.rb");
    const javaFile = path.join(projectRoot, "Main.java");
    const kotlinFile = path.join(projectRoot, "Main.kt");
    const csharpFile = path.join(projectRoot, "Program.cs");
    const cppFile = path.join(projectRoot, "main.cpp");
    const swiftFile = path.join(projectRoot, "main.swift");
    const graphWithManifests = {
      nodes: new Set([
        pythonFile,
        phpFile,
        rustFile,
        goFile,
        zigFile,
        rubyFile,
        javaFile,
        kotlinFile,
        csharpFile,
        cppFile,
        swiftFile,
      ]),
      edges: [
        { from: pythonFile, to: { type: "external" as const, name: "requests" }, raw: "requests" },
        { from: pythonFile, to: { type: "external" as const, name: "click" }, raw: "click" },
        { from: pythonFile, to: { type: "external" as const, name: "rich" }, raw: "rich" },
        { from: pythonFile, to: { type: "external" as const, name: "httpx" }, raw: "httpx" },
        { from: pythonFile, to: { type: "external" as const, name: "pydantic" }, raw: "pydantic" },
        { from: pythonFile, to: { type: "external" as const, name: "attrs" }, raw: "attrs" },
        { from: pythonFile, to: { type: "external" as const, name: "pendulum" }, raw: "pendulum" },
        { from: pythonFile, to: { type: "external" as const, name: "pytest" }, raw: "pytest" },
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
        { from: zigFile, to: { type: "external" as const, name: "foo-bar" }, raw: "foo-bar" },
        { from: rubyFile, to: { type: "external" as const, name: "rails" }, raw: "rails" },
        { from: rubyFile, to: { type: "external" as const, name: "sidekiq" }, raw: "sidekiq" },
        { from: rubyFile, to: { type: "external" as const, name: "rack" }, raw: "rack" },
        { from: rubyFile, to: { type: "external" as const, name: "rspec" }, raw: "rspec" },
        { from: javaFile, to: { type: "external" as const, name: "org.slf4j.Logger" }, raw: "org.slf4j.Logger" },
        {
          from: kotlinFile,
          to: { type: "external" as const, name: "com.google.guava.collect" },
          raw: "com.google.guava.collect",
        },
        { from: csharpFile, to: { type: "external" as const, name: "Newtonsoft.Json" }, raw: "Newtonsoft.Json" },
        { from: cppFile, to: { type: "external" as const, name: "fmt/core.h" }, raw: "fmt/core.h" },
        {
          from: cppFile,
          to: { type: "external" as const, name: "boost-filesystem/path.hpp" },
          raw: "boost-filesystem/path.hpp",
        },
        { from: swiftFile, to: { type: "external" as const, name: "Alamofire" }, raw: "Alamofire" },
        { from: pythonFile, to: { type: "external" as const, name: "missing_python" }, raw: "missing_python" },
        { from: phpFile, to: { type: "external" as const, name: "missing/php" }, raw: "missing/php" },
        { from: rustFile, to: { type: "external" as const, name: "missing_crate" }, raw: "missing_crate" },
        {
          from: goFile,
          to: { type: "external" as const, name: "example.com/missing/pkg" },
          raw: "example.com/missing/pkg",
        },
        { from: zigFile, to: { type: "external" as const, name: "missing_zig" }, raw: "missing_zig" },
        { from: rubyFile, to: { type: "external" as const, name: "missing_gem" }, raw: "missing_gem" },
        { from: javaFile, to: { type: "external" as const, name: "org.missing.Type" }, raw: "org.missing.Type" },
        { from: csharpFile, to: { type: "external" as const, name: "Missing.Package" }, raw: "Missing.Package" },
        { from: swiftFile, to: { type: "external" as const, name: "MissingSwift" }, raw: "MissingSwift" },
      ],
    };

    const unresolved = getUnresolvedImports(graphWithManifests, { projectRoot });

    expect(unresolved.map((entry) => entry.name)).toEqual([
      "missing_python",
      "missing/php",
      "missing_crate",
      "example.com/missing/pkg",
      "missing_zig",
      "missing_gem",
      "org.missing.Type",
      "Missing.Package",
      "MissingSwift",
    ]);
  });

  it("resets external classifier caches between long-lived analysis runs", () => {
    const projectRoot = makeTempRoot("cg-unresolved-cache-reset-");
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ dependencies: { react: "^19.0.0" } }),
      "utf8",
    );
    const srcFile = path.join(projectRoot, "app.ts");
    const graphWithReact = {
      nodes: new Set([srcFile]),
      edges: [{ from: srcFile, to: { type: "external" as const, name: "react" }, raw: "react" }],
    };

    expect(getUnresolvedImports(graphWithReact, { projectRoot })).toEqual([]);
    fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ dependencies: {} }), "utf8");
    resetExternalClassifierCaches();

    expect(getUnresolvedImports(graphWithReact, { projectRoot }).map((entry) => entry.name)).toEqual(["react"]);
  });

  it("bounds external classifier caches across many roots", () => {
    resetExternalClassifierCaches();
    const tempRoot = makeTempRoot("cg-unresolved-cache-bound-");

    try {
      for (let index = 0; index < 520; index++) {
        const projectRoot = path.join(tempRoot, `project-${index}`);
        fs.mkdirSync(projectRoot);
        fs.writeFileSync(
          path.join(projectRoot, "package.json"),
          JSON.stringify({ dependencies: { [`package-${index}`]: "^1.0.0" } }),
          "utf8",
        );
        const srcFile = path.join(projectRoot, "app.ts");
        getUnresolvedImports(
          {
            nodes: new Set([srcFile]),
            edges: [
              { from: srcFile, to: { type: "external" as const, name: `package-${index}` }, raw: `package-${index}` },
            ],
          },
          { projectRoot },
        );
      }

      const stats = getExternalClassifierCacheStats();
      expect(stats.dependencyManifests).toBeLessThanOrEqual(512);
      expect(stats.declaredPackageContexts).toBeLessThanOrEqual(512);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("does not count supported-language stdlib and URL externals as unresolved imports", () => {
    const projectRoot = makeTempRoot("cg-unresolved-stdlib-");
    const graphWithStdlib = {
      nodes: new Set([
        path.join(projectRoot, "main.py"),
        path.join(projectRoot, "main.go"),
        path.join(projectRoot, "main.rb"),
        path.join(projectRoot, "main.zig"),
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
        { from: path.join(projectRoot, "main.rb"), to: { type: "external" as const, name: "json" }, raw: "json" },
        { from: path.join(projectRoot, "main.zig"), to: { type: "external" as const, name: "std" }, raw: "std" },
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
    const { root, graph } = makeBasicGraph();
    const hotspots = getHotspots(graph);
    expect(hotspots.length).toBe(2);
    expect(hotspots[0].file).toBe(path.join(root, "b.ts"));
    expect(hotspots[0].fanIn).toBe(1);
  });

  it("should limit and filter hotspots by include roots", () => {
    const root = makeTempRoot("cg-graph-report-hotspots-");
    const scopedGraph = {
      nodes: new Set([
        path.join(root, "src", "a.ts"),
        path.join(root, "src", "b.ts"),
        path.join(root, "src", "c.ts"),
        path.join(root, "tests", "spec.ts"),
      ]),
      edges: [
        {
          from: path.join(root, "src", "a.ts"),
          to: { type: "file" as const, path: path.join(root, "src", "b.ts") },
          raw: "./b",
        },
        {
          from: path.join(root, "src", "c.ts"),
          to: { type: "file" as const, path: path.join(root, "src", "b.ts") },
          raw: "./b",
        },
        {
          from: path.join(root, "tests", "spec.ts"),
          to: { type: "file" as const, path: path.join(root, "src", "a.ts") },
          raw: "../src/a",
        },
      ],
    };

    const hotspots = getHotspots(scopedGraph, {
      includeRoots: [path.join(root, "src")],
      limit: 2,
    });

    expect(hotspots).toEqual([
      {
        file: path.join(root, "src", "b.ts"),
        fanIn: 2,
        fanOut: 0,
        score: 4,
      },
      {
        file: path.join(root, "src", "a.ts"),
        fanIn: 0,
        fanOut: 1,
        score: 1,
      },
    ]);
  });

  it("should ignore non-finite hotspot limits", () => {
    const { graph } = makeBasicGraph();
    expect(getHotspots(graph, { limit: Number.NaN })).toEqual(getHotspots(graph));
    expect(getHotspots(graph, { limit: Number.POSITIVE_INFINITY })).toEqual(getHotspots(graph));
  });

  it("should get API surface", () => {
    const root = makeTempRoot("cg-graph-report-api-");
    const file = path.join(root, "a.ts");
    const mockIndex = {
      byFile: new Map([
        [
          file,
          {
            file,
            exports: [
              {
                type: "local" as const,
                exportedAs: "foo",
                target: { localName: "foo", kind: SymbolKind.Function, range: {}, file },
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
    expect(api[0].file).toBe(file);
    expect(api[0].exports[0].exportedAs).toBe("foo");
  });

  it("should handle complex re-export chains in apisurface", () => {
    const root = makeTempRoot("cg-graph-report-api-chain-");
    const libFile = path.join(root, "lib.ts");
    const barrelFile = path.join(root, "barrel.ts");
    const mockIndex = {
      byFile: new Map([
        [
          libFile,
          {
            file: libFile,
            exports: [
              {
                type: "local",
                exportedAs: "base",
                target: { localName: "base", kind: SymbolKind.Variable, file: libFile, range: {} },
              },
            ],
            imports: [],
            locals: [],
          },
        ],
        [
          barrelFile,
          {
            file: barrelFile,
            exports: [
              { type: "reexport", exportedAs: "aliased", fromModule: libFile, sourceSpecifier: "base" },
              { type: "exportStar", fromModule: libFile },
            ],
            imports: [],
            locals: [],
          },
        ],
      ]),
    };
    const api = getApiSurface(mockIndex);
    const barrel = api.find((a) => a.file === barrelFile);
    expect(barrel).toBeDefined();
    expect(barrel!.exports.some((e) => e.exportedAs === "aliased" && e.kind === "reexport")).toBe(true);
    expect(barrel!.exports.some((e) => e.kind === "exportStar")).toBe(true);
  });
});
