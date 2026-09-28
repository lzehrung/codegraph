import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed, type DetailedSymbolGraph } from "../src/graphs/symbol-graph-detailed.js";
import { buildProjectIndex, findReferences, goToDefinition } from "../src/index.js";
import { STAR_IMPORT_PRECEDENCE } from "../src/indexer/star-import-precedence.js";
import type { ProjectIndex } from "../src/indexer/types.js";
import { fileIdentityKey } from "../src/util/paths.js";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function project(prefix: string, files: Record<string, string>): Promise<{ root: string; index: ProjectIndex }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source, "utf8");
  }
  const index = await buildProjectIndex(root, { cache: "off", native: "on" });
  return { root, index };
}

function at(source: string, phrase: string, token = phrase, occurrence = 0): { line: number; column: number } {
  let from = 0;
  let phraseAt = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    phraseAt = source.indexOf(phrase, from);
    if (phraseAt < 0) throw new Error(`missing ${phrase}`);
    from = phraseAt + phrase.length;
  }
  const tokenOffset = phrase.indexOf(token);
  if (tokenOffset < 0) throw new Error(`missing ${token} in ${phrase}`);
  const start = phraseAt + tokenOffset;
  const prefix = source.slice(0, start);
  const line = prefix.split("\n").length;
  const column = start - prefix.lastIndexOf("\n");
  return { line, column };
}

function fileIn(root: string, name: string): string {
  return path.join(root, name);
}

function baseName(file: string): string {
  return path.basename(file);
}

function typeNode(graph: DetailedSymbolGraph, file: string, name: string): string {
  const matches = [...graph.nodes.values()].filter(
    (node) => node.kind === "class" && node.name === name && path.basename(node.file) === file,
  );
  expect(matches, name).toHaveLength(1);
  return matches[0]?.id ?? "";
}
function functionNode(graph: DetailedSymbolGraph, file: string, name: string): string {
  const matches = [...graph.nodes.values()].filter(
    (node) => node.kind === "function" && node.name === name && path.basename(node.file) === file,
  );
  expect(matches, name).toHaveLength(1);
  return matches[0]?.id ?? "";
}

function edgeBetween(graph: DetailedSymbolGraph, from: string, to: string, label: string): boolean {
  return graph.edges.some((edge) => edge.from === from && edge.to === to && edge.label === label);
}

describe("star-import precedence", () => {
  it("records each language's star-import conflict rule", () => {
    expect(STAR_IMPORT_PRECEDENCE.python).toBe("last-wins");
    expect(STAR_IMPORT_PRECEDENCE.java).toBe("explicit-beats-star");
    expect(STAR_IMPORT_PRECEDENCE.kotlin).toBe("explicit-beats-star");
    expect(STAR_IMPORT_PRECEDENCE.rust).toBe("explicit-beats-star");
    expect(STAR_IMPORT_PRECEDENCE.ruby).toBe("ambiguous");
    expect(STAR_IMPORT_PRECEDENCE.c).toBe("ambiguous");
    expect(STAR_IMPORT_PRECEDENCE.cpp).toBe("ambiguous");
  });

  it("treats two Ruby classes loaded by a third file as one reopened constant", async () => {
    const pkgA = "class Base\nend\n";
    const pkgB = "class Base\nend\n";
    const worker = 'require_relative "pkg_a/base"\nrequire_relative "pkg_b/base"\n\nclass Worker < Base\nend\n';
    const { root, index } = await project("cg-ruby-reopen-both-", {
      "pkg_a/base.rb": pkgA,
      "pkg_b/base.rb": pkgB,
      "worker.rb": worker,
    });
    const workerFile = fileIn(root, "worker.rb");
    const resolved = await goToDefinition(index, { file: workerFile, ...at(worker, "class Worker < Base", "Base") });
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;
    expect(baseName(resolved.definition.file)).toBe("base.rb");
    expect(resolved.definition.file.replace(/\\/g, "/")).toMatch(/pkg_a\/base\.rb$/);
    expect(resolved.definition.range.start.line).toBe(1);
    expect(resolved.provenance?.resolution).toBe("import-star");
    expect(resolved.provenance?.confidence).toBe("medium");

    const graph = await buildSymbolGraphDetailed(index);
    const classEnding = (suffix: string, name: string): string => {
      const matches = [...graph.nodes.values()].filter(
        (node) => node.kind === "class" && node.name === name && node.file.replace(/\\/g, "/").endsWith(suffix),
      );
      expect(matches, suffix).toHaveLength(1);
      return matches[0]?.id ?? "";
    };
    const workerType = classEnding("worker.rb", "Worker");
    const firstType = classEnding("pkg_a/base.rb", "Base");
    const secondType = classEnding("pkg_b/base.rb", "Base");
    expect(edgeBetween(graph, workerType, firstType, "extends")).toBe(true);
    expect(edgeBetween(graph, workerType, secondType, "extends")).toBe(false);

    for (const file of ["pkg_a/base.rb", "pkg_b/base.rb"]) {
      const source = file.endsWith("pkg_a/base.rb") ? pkgA : pkgB;
      const references = await findReferences(index, { file: fileIn(root, file), ...at(source, "class Base", "Base") });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") continue;
      expect(references.referenceCoverage?.state).toBe("complete");
      const siteLabel = (file: string): string => {
        const normalized = file.replace(/\\/g, "/");
        for (const known of ["pkg_a/base.rb", "pkg_b/base.rb"]) {
          if (normalized.endsWith(known)) return known;
        }
        return path.basename(file);
      };
      const sites = references.references.map(
        (reference) => `${siteLabel(reference.file)}:${reference.range.start.line}`,
      );
      expect(sites).toContain("pkg_a/base.rb:1");
      expect(sites).toContain("pkg_b/base.rb:1");
      expect(sites).toContain("worker.rb:4");
    }
  });

  it("resolves a Ruby class reopened across a require to the opening declaration and lists both parts", async () => {
    const origin = "class Base\nend\n";
    const reopen = 'require_relative "origin"\nclass Base\n  def extra\n  end\nend\n';
    const worker = 'require_relative "reopen"\nrequire_relative "origin"\n\nclass Worker < Base\nend\n';
    const { root, index } = await project("cg-ruby-reopen-", {
      "origin.rb": origin,
      "reopen.rb": reopen,
      "worker.rb": worker,
    });
    const workerFile = fileIn(root, "worker.rb");
    const resolved = await goToDefinition(index, { file: workerFile, ...at(worker, "class Worker < Base", "Base") });
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;
    expect(baseName(resolved.definition.file)).toBe("origin.rb");
    expect(resolved.definition.range.start.line).toBe(1);
    expect(resolved.provenance?.resolution).toBe("import-star");
    expect(resolved.provenance?.confidence).toBe("medium");

    const graph = await buildSymbolGraphDetailed(index);
    const workerType = typeNode(graph, "worker.rb", "Worker");
    const originType = typeNode(graph, "origin.rb", "Base");
    const reopenType = typeNode(graph, "reopen.rb", "Base");
    expect(edgeBetween(graph, workerType, originType, "extends")).toBe(true);
    expect(edgeBetween(graph, workerType, reopenType, "extends")).toBe(false);

    const originRefs = await findReferences(index, {
      file: fileIn(root, "origin.rb"),
      ...at(origin, "class Base", "Base"),
    });
    expect(originRefs.status).toBe("ok");
    if (originRefs.status !== "ok") return;
    expect(originRefs.referenceCoverage?.state).toBe("complete");
    const originSites = originRefs.references.map(
      (reference) => `${path.basename(reference.file)}:${reference.range.start.line}`,
    );
    expect(originSites).toContain("origin.rb:1");
    expect(originSites).toContain("reopen.rb:2");
    expect(originSites).toContain("worker.rb:4");

    const reopenRefs = await findReferences(index, {
      file: fileIn(root, "reopen.rb"),
      ...at(reopen, "class Base", "Base"),
    });
    expect(reopenRefs.status).toBe("ok");
    if (reopenRefs.status !== "ok") return;
    expect(reopenRefs.referenceCoverage?.state).toBe("complete");
    const reopenSites = reopenRefs.references.map(
      (reference) => `${path.basename(reference.file)}:${reference.range.start.line}`,
    );
    expect(reopenSites).toContain("origin.rb:1");
    expect(reopenSites).toContain("reopen.rb:2");
    expect(reopenSites).toContain("worker.rb:4");
  });

  it("lets the later Python star import rebind a shared name", async () => {
    const earlier = "def helper():\n    return 1\n";
    const later = "def helper():\n    return 2\n";
    const main = "from zzz import *\nfrom aaa import *\n\ndef run():\n    helper()\n";
    const { root, index } = await project("cg-python-", {
      "zzz.py": earlier,
      "aaa.py": later,
      "main.py": main,
    });
    const resolved = await goToDefinition(index, { file: fileIn(root, "main.py"), ...at(main, "helper()", "helper") });
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;
    expect(baseName(resolved.definition.file)).toBe("aaa.py");
    expect(resolved.provenance?.resolution).toBe("import-star");
    expect(resolved.provenance?.confidence).toBe("medium");
  });

  it("lets an explicit Java import beat an earlier wildcard and rejects two wildcards", async () => {
    const baseA = "package pkg.a;\n\npublic class Base {}\n";
    const baseB = "package pkg.b;\n\npublic class Base {}\n";
    const explicit = "package app;\n\nimport pkg.b.*;\nimport pkg.a.Base;\n\npublic class Main {\n    Base value;\n}\n";
    const wildcards =
      "package app;\n\nimport pkg.a.*;\nimport pkg.b.*;\n\npublic class Ambiguous {\n    Base value;\n}\n";
    const only = "package app;\n\nimport pkg.a.*;\n\npublic class Only {\n    Base value;\n}\n";
    const { root, index } = await project("cg-java-", {
      "pkg/a/Base.java": baseA,
      "pkg/b/Base.java": baseB,
      "app/Main.java": explicit,
      "app/Ambiguous.java": wildcards,
      "app/Only.java": only,
    });

    const explicitHit = await goToDefinition(index, {
      file: fileIn(root, "app/Main.java"),
      ...at(explicit, "Base value", "Base"),
    });
    expect(explicitHit.status).toBe("ok");
    if (explicitHit.status !== "ok") return;
    expect(explicitHit.definition.file.replace(/\\/g, "/")).toMatch(/pkg\/a\/Base\.java$/);
    expect(explicitHit.provenance?.resolution).toBe("import");
    expect(explicitHit.provenance?.confidence).toBe("high");

    const onlyHit = await goToDefinition(index, {
      file: fileIn(root, "app/Only.java"),
      ...at(only, "Base value", "Base"),
    });
    expect(onlyHit.status).toBe("ok");
    if (onlyHit.status !== "ok") return;
    expect(onlyHit.definition.file.replace(/\\/g, "/")).toMatch(/pkg\/a\/Base\.java$/);
    expect(onlyHit.provenance?.resolution).toBe("import-star");
    expect(onlyHit.provenance?.confidence).toBe("medium");

    const ambiguous = await goToDefinition(index, {
      file: fileIn(root, "app/Ambiguous.java"),
      ...at(wildcards, "Base value", "Base"),
    });
    expect(ambiguous.status).toBe("not_found");
    if (ambiguous.status === "not_found") expect(ambiguous.reason).toBe("Ambiguous star import");

    const references = await findReferences(index, {
      file: fileIn(root, "pkg/a/Base.java"),
      ...at(baseA, "class Base", "Base"),
    });
    expect(references.status).toBe("ok");
    if (references.status !== "ok") return;
    expect(references.referenceCoverage?.state).toBe("partial");
    const ambiguousUses = references.references.filter(
      (reference) => path.basename(reference.file) === "Ambiguous.java",
    );
    expect(ambiguousUses).toEqual([]);
  });

  it("does not let a Java wildcard rescue an unresolved explicit import", async () => {
    const imported =
      "package pkg.fallback;\n\npublic class Foo {\n    public int hit() {\n        return 1;\n    }\n}\n";
    const main =
      "package app;\n\nimport missing.Foo;\nimport pkg.fallback.*;\n\npublic class Main {\n    public int run() {\n" +
      "        Foo value = new Foo();\n        return value.hit();\n    }\n}\n";
    const { root, index } = await project("cg-java-unresolved-explicit-", {
      "pkg/fallback/Foo.java": imported,
      "app/Main.java": main,
    });
    const unresolved = await goToDefinition(index, {
      file: fileIn(root, "app/Main.java"),
      ...at(main, "Foo value", "Foo"),
    });
    expect(unresolved.status).toBe("not_found");

    const graph = await buildSymbolGraphDetailed(index);
    const run = functionNode(graph, "Main.java", "run");
    const hit = functionNode(graph, "Foo.java", "hit");
    expect(edgeBetween(graph, run, hit, "calls")).toBe(false);
  });

  it("keeps a resolved Java explicit import ahead of a wildcard", async () => {
    const preferred = "package preferred;\n\npublic class Foo {}\n";
    const wildcard = "package wildcard;\n\npublic class Foo {}\n";
    const main =
      "package app;\n\nimport wildcard.*;\nimport preferred.Foo;\n\npublic class Main {\n    Foo value;\n}\n";
    const { root, index } = await project("cg-java-resolved-explicit-", {
      "preferred/Foo.java": preferred,
      "wildcard/Foo.java": wildcard,
      "app/Main.java": main,
    });
    const resolved = await goToDefinition(index, {
      file: fileIn(root, "app/Main.java"),
      ...at(main, "Foo value", "Foo"),
    });
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;
    expect(resolved.definition.file.replace(/\\/g, "/")).toMatch(/preferred\/Foo\.java$/);
  });

  it("does not let an unresolved later Python import fall back to an earlier star import", async () => {
    const published = "class Thing:\n    def hit(self):\n        return 1\n";
    const main = "from published import *\nfrom missing import Thing\n\ndef run():\n    return Thing().hit()\n";
    const { root, index } = await project("cg-python-unresolved-explicit-", {
      "published.py": published,
      "main.py": main,
    });
    const unresolved = await goToDefinition(index, {
      file: fileIn(root, "main.py"),
      ...at(main, "Thing().hit()", "Thing"),
    });
    expect(unresolved.status).toBe("not_found");

    // The receiver stays unresolved, so its member cannot resolve through the earlier star
    // import either: `hit` must not reach published.Thing.hit.
    const member = await goToDefinition(index, {
      file: fileIn(root, "main.py"),
      ...at(main, "Thing().hit()", "hit"),
    });
    expect(member.status).toBe("not_found");

    const graph = await buildSymbolGraphDetailed(index);
    const run = functionNode(graph, "main.py", "run");
    const hit = functionNode(graph, "published.py", "hit");
    expect(edgeBetween(graph, run, hit, "calls")).toBe(false);
  });

  it("uses the later Python import over an earlier local class in navigation and graph calls", async () => {
    const imported = "class Thing:\n    def hit(self):\n        return 2\n";
    const main =
      "class Thing:\n    def hit(self):\n        return 1\n\nfrom imported import Thing\n\ndef run():\n    return Thing().hit()\n";
    const { root, index } = await project("cg-python-later-import-", {
      "imported.py": imported,
      "main.py": main,
    });
    const resolved = await goToDefinition(index, {
      file: fileIn(root, "main.py"),
      ...at(main, "Thing().hit()", "Thing"),
    });
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;
    expect(baseName(resolved.definition.file)).toBe("imported.py");

    const graph = await buildSymbolGraphDetailed(index);
    const run = functionNode(graph, "main.py", "run");
    const importedHit = functionNode(graph, "imported.py", "hit");
    const localHit = functionNode(graph, "main.py", "hit");
    expect(edgeBetween(graph, run, importedHit, "calls")).toBe(true);
    expect(edgeBetween(graph, run, localHit, "calls")).toBe(false);
  });

  it("uses the later Python local class over an earlier import", async () => {
    const imported = "class Thing:\n    def hit(self):\n        return 2\n";
    const main =
      "from imported import Thing\n\nclass Thing:\n    def hit(self):\n        return 1\n\ndef run():\n    return Thing().hit()\n";
    const { root, index } = await project("cg-python-later-local-", {
      "imported.py": imported,
      "main.py": main,
    });
    const resolved = await goToDefinition(index, {
      file: fileIn(root, "main.py"),
      ...at(main, "Thing().hit()", "Thing"),
    });
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;
    expect(baseName(resolved.definition.file)).toBe("main.py");

    const graph = await buildSymbolGraphDetailed(index);
    const run = functionNode(graph, "main.py", "run");
    const importedHit = functionNode(graph, "imported.py", "hit");
    const localHit = functionNode(graph, "main.py", "hit");
    expect(edgeBetween(graph, run, localHit, "calls")).toBe(true);
    expect(edgeBetween(graph, run, importedHit, "calls")).toBe(false);
  });

  it("keeps a module import when a later function declares the same Python name locally", async () => {
    const imported = "class X:\n    pass\n";
    const main =
      "from a import X\n\ndef inner():\n    class X:\n        pass\n    return X()\n\nclass Child(X):\n    pass\n";
    const { root, index } = await project("cg-python-nested-local-", {
      "a.py": imported,
      "main.py": main,
    });
    const file = fileIn(root, "main.py");
    const moduleUse = await goToDefinition(index, { file, ...at(main, "class Child(X)", "X") });
    expect(moduleUse.status).toBe("ok");
    if (moduleUse.status === "ok") {
      expect(fileIdentityKey(moduleUse.definition.file)).toBe(fileIdentityKey(fileIn(root, "a.py")));
      expect(moduleUse.definition.range.start.line).toBe(1);
    }
    const localUse = await goToDefinition(index, { file, ...at(main, "return X()", "X") });
    expect(localUse.status).toBe("ok");
    if (localUse.status === "ok") {
      expect(fileIdentityKey(localUse.definition.file)).toBe(fileIdentityKey(file));
      expect(localUse.definition.range.start.line).toBe(4);
    }

    const graph = await buildSymbolGraphDetailed(index);
    const child = typeNode(graph, "main.py", "Child");
    expect(edgeBetween(graph, child, typeNode(graph, "a.py", "X"), "extends")).toBe(true);
    expect(edgeBetween(graph, child, typeNode(graph, "main.py", "X"), "extends")).toBe(false);
  });

  it("rejects two Rust glob imports of the same name and still resolves one glob", async () => {
    const left = "pub fn shared() -> i32 { 1 }\n";
    const right = "pub fn shared() -> i32 { 2 }\n";
    const consumer = "use crate::left::*;\nuse crate::right::*;\n\npub fn run() -> i32 {\n    shared()\n}\n";
    const only = "use crate::left::*;\n\npub fn run() -> i32 {\n    shared()\n}\n";
    const lib = "pub mod left;\npub mod right;\npub mod consumer;\npub mod only;\n";
    const { root, index } = await project("cg-rust-", {
      "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
      "src/lib.rs": lib,
      "src/left.rs": left,
      "src/right.rs": right,
      "src/consumer.rs": consumer,
      "src/only.rs": only,
    });

    const onlyHit = await goToDefinition(index, {
      file: fileIn(root, "src/only.rs"),
      ...at(only, "shared()", "shared"),
    });
    expect(onlyHit.status).toBe("ok");
    if (onlyHit.status !== "ok") return;
    expect(baseName(onlyHit.definition.file)).toBe("left.rs");

    const ambiguous = await goToDefinition(index, {
      file: fileIn(root, "src/consumer.rs"),
      ...at(consumer, "shared()", "shared"),
    });
    expect(ambiguous.status).toBe("not_found");
    if (ambiguous.status === "not_found") expect(ambiguous.reason).toBe("Ambiguous star import");

    const references = await findReferences(index, {
      file: fileIn(root, "src/left.rs"),
      ...at(left, "fn shared", "shared"),
    });
    expect(references.status).toBe("ok");
    if (references.status !== "ok") return;
    expect(references.referenceCoverage?.state).toBe("partial");
    const ambiguousUses = references.references.filter((reference) => path.basename(reference.file) === "consumer.rs");
    expect(ambiguousUses).toEqual([]);
  });

  it("lets a Java same-package class beat an on-demand wildcard", async () => {
    const localBase = "package pkg;\n\npublic class Base {}\n";
    const otherBase = "package other;\n\npublic class Base {}\n";
    const wildcard = "package pkg;\n\nimport other.*;\n\npublic class Use {\n    Base value;\n}\n";
    const explicit = "package pkg;\n\nimport other.Base;\n\npublic class Explicit {\n    Base value;\n}\n";
    const { root, index } = await project("cg-java-package-", {
      "pkg/Base.java": localBase,
      "other/Base.java": otherBase,
      "pkg/Use.java": wildcard,
      "pkg/Explicit.java": explicit,
    });
    const wildcardHit = await goToDefinition(index, {
      file: fileIn(root, "pkg/Use.java"),
      ...at(wildcard, "Base value", "Base"),
    });
    expect(wildcardHit.status).toBe("ok");
    if (wildcardHit.status !== "ok") return;
    expect(wildcardHit.definition.file.replace(/\\/g, "/")).toMatch(/pkg\/Base\.java$/);
    expect(wildcardHit.provenance?.resolution).toBe("exact");
    expect(wildcardHit.provenance?.confidence).toBe("high");

    const explicitHit = await goToDefinition(index, {
      file: fileIn(root, "pkg/Explicit.java"),
      ...at(explicit, "Base value", "Base"),
    });
    expect(explicitHit.status).toBe("ok");
    if (explicitHit.status !== "ok") return;
    expect(explicitHit.definition.file.replace(/\\/g, "/")).toMatch(/other\/Base\.java$/);
    expect(explicitHit.provenance?.resolution).toBe("import");
    expect(explicitHit.provenance?.confidence).toBe("high");
  });

  it("treats one C function declared in two headers as one callable", async () => {
    const api = "int add(int a, int b);\n";
    const internal = "int add(int a, int b);\n";
    const add = '#include "api.h"\nint add(int a, int b) { return a + b; }\n';
    const main = '#include "api.h"\n#include "internal.h"\nint run(void) { return add(1, 2); }\n';
    const { root, index } = await project("cg-c-headers-", {
      "api.h": api,
      "internal.h": internal,
      "add.c": add,
      "main.c": main,
    });
    const resolved = await goToDefinition(index, {
      file: fileIn(root, "main.c"),
      ...at(main, "return add(1, 2)", "add"),
    });
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;
    expect(baseName(resolved.definition.file)).toBe("api.h");
    expect(resolved.definition.range.start.line).toBe(1);

    const references = await findReferences(index, {
      file: fileIn(root, "add.c"),
      ...at(add, "int add(int a, int b)", "add"),
    });
    expect(references.status).toBe("ok");
    if (references.status !== "ok") return;
    expect(references.referenceCoverage?.state).toBe("complete");
    const sites = references.references.map(
      (reference) => `${path.basename(reference.file)}:${reference.range.start.line}`,
    );
    expect(sites).toContain("main.c:3");
  });
});
