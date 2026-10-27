import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildProjectIndex, resolveExport, resolveImported } from "../src/index.js";
import {
  SymbolKind,
  type ImportBinding,
  type ModuleIndex,
  type ProjectIndex,
  type SymbolDef,
} from "../src/indexer/types.js";
import { supportById } from "../src/languages.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { collectJvmFileFacts, type JvmFileFacts } from "../src/util/jvm-tree.js";
import { parseSyntaxTree, type JvmLanguageId } from "../src/util/syntax-tree.js";
import { createTempProjectRoot, type TempProjectFile } from "./helpers/filesystem.js";
import { expectResolvedDef, makeTestProjectIndex } from "./helpers/narrow.js";

const GO_CALLER = "package app\n\nfunc Main() {\n\tWidget()\n}\n";
const GO_WIDGET = "package app\n\nfunc Widget() {\n}\n";
const GO_ALPHA = "package app\n\nfunc Alpha() {\n}\n";
const JAVA_WIDGET = "package app;\n\npublic class Widget {\n}\n";
const JAVA_ALPHA = "package app;\n\npublic class Alpha {\n}\n";
const KOTLIN_BETA = "package app\n\nfun beta() {\n}\n";

const tempRoots: string[] = [];

type ReadPathsResult<T> = {
  value: T;
  /** Absolute paths passed to synchronous reads while the action ran. */
  paths: string[];
};

/**
 * Package-name extraction is the only synchronous read left in export resolution, so recording
 * every `readFileSync` target shows exactly which modules a lookup opened.
 */
async function withSyncReadPaths<T>(action: () => Promise<T> | T): Promise<ReadPathsResult<T>> {
  const readFileSync = vi.spyOn(fs, "readFileSync");
  try {
    const value = await action();
    const paths: string[] = [];
    for (const [target] of readFileSync.mock.calls) {
      if (typeof target === "string") paths.push(target);
    }
    return { value, paths };
  } finally {
    readFileSync.mockRestore();
  }
}

function moduleFileEndingWith(index: ProjectIndex, suffix: string): string {
  for (const module of index.byFile.values()) {
    if (module.file.endsWith(suffix)) return module.file;
  }
  throw new Error(`No indexed module ended with ${suffix}`);
}

function readsWithExtension(paths: readonly string[], extension: string): string[] {
  return paths.filter((target) => target.toLowerCase().endsWith(extension));
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("package export resolution", () => {
  it("resolves a Go package export without reading same-directory files of other languages", async () => {
    const root = await createTempProjectRoot("cg-package-go-", [
      { path: "app/main.go", contents: GO_CALLER },
      { path: "app/widget.go", contents: GO_WIDGET },
      // Both declare `package app`, and a Java declaration also matches the Go package pattern.
      { path: "app/Widget.java", contents: JAVA_WIDGET },
      { path: "app/notes.md", contents: "package app\n" },
    ]);
    tempRoots.push(root);
    const index = await buildProjectIndex(root, { cache: "off" });
    const mainGo = moduleFileEndingWith(index, "main.go");
    const widgetGo = moduleFileEndingWith(index, "widget.go");

    const resolved = await withSyncReadPaths(() => resolveExport(index, mainGo, "Widget"));

    // Only the Go sibling is a candidate, so the name is unambiguous.
    expect(expectResolvedDef(resolved.value).file).toBe(widgetGo);
    expect(readsWithExtension(resolved.paths, ".java")).toEqual([]);
    expect(readsWithExtension(resolved.paths, ".md")).toEqual([]);
  });

  it("takes package declarations from retained parsed source instead of the file", async () => {
    const root = await createTempProjectRoot("cg-package-go-parsed-", [
      { path: "app/main.go", contents: GO_CALLER },
      { path: "app/widget.go", contents: GO_WIDGET },
    ]);
    tempRoots.push(root);
    const index = await buildProjectIndex(root, { cache: "off", keepParsed: true });
    const mainGo = moduleFileEndingWith(index, "main.go");
    const widgetGo = moduleFileEndingWith(index, "widget.go");

    const resolved = await withSyncReadPaths(() => resolveExport(index, mainGo, "Widget"));

    expect(expectResolvedDef(resolved.value).file).toBe(widgetGo);
    expect(readsWithExtension(resolved.paths, ".go")).toEqual([]);
  });

  it("keeps a Java sibling visible to Kotlin package resolution and skips other languages", async () => {
    const root = await createTempProjectRoot("cg-package-jvm-", [
      { path: "app/Beta.kt", contents: KOTLIN_BETA },
      { path: "app/Alpha.java", contents: JAVA_ALPHA },
      // Declares `package app` too, and would otherwise make `Alpha` ambiguous for Kotlin.
      { path: "app/alpha.go", contents: GO_ALPHA },
    ]);
    tempRoots.push(root);
    const index = await buildProjectIndex(root, { cache: "off" });
    const betaKt = moduleFileEndingWith(index, "Beta.kt");
    const alphaJava = moduleFileEndingWith(index, "Alpha.java");

    const binding: ImportBinding = {
      kind: "named",
      local: "Alpha",
      imported: "Alpha",
      from: "./Alpha",
      resolved: betaKt,
    };
    const resolved = await withSyncReadPaths(() => resolveImported(index, binding, "Alpha"));

    const hit = resolved.value;
    expect(hit && "file" in hit ? hit.file : null).toBe(alphaJava);
    expect(readsWithExtension(resolved.paths, ".go")).toEqual([]);
  });

  it("uses custom language extensions for JVM sibling package resolution", async () => {
    const root = await createTempProjectRoot("cg-package-jvm-mapped-", [
      { path: "app/Beta.jvm", contents: KOTLIN_BETA },
      { path: "app/Alpha.java", contents: JAVA_ALPHA },
    ]);
    tempRoots.push(root);
    const index = await buildProjectIndex(root, {
      cache: "off",
      languageExtensions: { ".jvm": "kotlin" },
    });
    const betaJvm = moduleFileEndingWith(index, "Beta.jvm");
    const alphaJava = moduleFileEndingWith(index, "Alpha.java");

    const binding: ImportBinding = {
      kind: "named",
      local: "Alpha",
      imported: "Alpha",
      from: "./Alpha",
      resolved: betaJvm,
    };
    const resolved = resolveImported(index, binding, "Alpha");

    expect(resolved && "file" in resolved ? resolved.file : null).toBe(alphaJava);
  });

  it("resolves a Kotlin package member from a Java anchor, except when the package spans directories", async () => {
    const files = [
      { path: "pkg/Anchor.java", contents: "package p;\nclass Anchor {}\n" },
      { path: "pkg/Sibling.kt", contents: "package p\nclass Sibling { fun Widget() {} }\n" },
    ];
    const resolveWidget = async (extra: readonly TempProjectFile[]): Promise<string | null> => {
      const root = await createTempProjectRoot("cg-package-kotlin-member-", [...files, ...extra]);
      tempRoots.push(root);
      const index = await buildProjectIndex(root, { cache: "off" });
      const binding: ImportBinding = {
        kind: "named",
        local: "Widget",
        imported: "Widget",
        from: "./Widget",
        resolved: moduleFileEndingWith(index, "Anchor.java"),
      };
      const hit = resolveImported(index, binding, "Widget");
      return hit && "localName" in hit ? `${path.basename(hit.file)}:${hit.localName}` : null;
    };

    expect(await resolveWidget([])).toBe("Sibling.kt:Widget");
    // The same package in another directory may declare `Widget` too, so the peer set is incomplete.
    expect(await resolveWidget([{ path: "other/Other.java", contents: "package p;\nclass Other {}\n" }])).toBeNull();
  });
});

describe("sibling package export peers", () => {
  function memberExport(file: string, exportedName: string): SymbolDef {
    return {
      file,
      localName: exportedName,
      kind: SymbolKind.Function,
      isMember: true,
      range: {
        start: { line: 3, column: 3, index: 20 },
        end: { line: 3, column: 3 + exportedName.length, index: 20 + exportedName.length },
      },
    };
  }

  /** The facts the build stores with a Java or Kotlin module, read from the module's own source. */
  function jvmFactsOf(file: string, source: string): JvmFileFacts {
    const languageId: JvmLanguageId = file.endsWith(".kt") ? "kotlin" : "java";
    const tree = parseSyntaxTree(source, supportById(languageId)!).tree;
    if (!tree) throw new Error(`Expected a ${languageId} syntax tree for ${file}`);
    return collectJvmFileFacts(tree, languageId);
  }

  /**
   * A member export is invisible to the compilation-unit bare-name scan, so sibling package
   * resolution is the only path that can answer it. Each module carries the package facts the build
   * stores for it; `unreadableFile` carries none, as when its syntax tree was unavailable.
   */
  function packageMemberIndex(input: {
    anchor: { file: string; source: string };
    sibling: { file: string; source: string };
    exportedName: string;
    unreadableFile?: string;
  }): { index: ProjectIndex; member: SymbolDef } {
    const member = memberExport(input.sibling.file, input.exportedName);
    const siblingModule: ModuleIndex = {
      file: input.sibling.file,
      exports: [{ type: "local", exportedAs: input.exportedName, target: member }],
      imports: [],
      locals: [member],
      jvmFacts: jvmFactsOf(input.sibling.file, input.sibling.source),
    };
    const anchorModule: ModuleIndex = {
      file: input.anchor.file,
      exports: [],
      imports: [],
      locals: [],
      jvmFacts: jvmFactsOf(input.anchor.file, input.anchor.source),
    };
    const byFile = new Map<string, ModuleIndex>([
      [fileIdentityKey(input.anchor.file), anchorModule],
      [fileIdentityKey(input.sibling.file), siblingModule],
    ]);
    if (input.unreadableFile) {
      byFile.set(fileIdentityKey(input.unreadableFile), {
        file: input.unreadableFile,
        exports: [],
        imports: [],
        locals: [],
      });
    }
    return { index: makeTestProjectIndex({ byFile, modules: byFile }), member };
  }

  function importedName(resolved: string, exportedName: string): ImportBinding {
    return { kind: "named", local: exportedName, imported: exportedName, from: `./${exportedName}`, resolved };
  }

  it("does not resolve a sibling member when a same-directory JVM peer cannot be read", () => {
    const root = path.resolve("cg-sibling-package-unreadable").replace(/\\/g, "/");
    const anchor = `${root}/pkg/Anchor.java`;
    const input = {
      anchor: { file: anchor, source: "package p;\nclass Anchor {}\n" },
      sibling: { file: `${root}/pkg/Sibling.java`, source: "package p;\nclass Sibling { void Widget() {} }\n" },
      exportedName: "Widget",
    };

    // Without the unread file, the readable sibling is the unique answer.
    const readable = packageMemberIndex(input);
    const hit = resolveImported(readable.index, importedName(anchor, "Widget"), "Widget");
    expect(hit && "localName" in hit ? hit : null).toEqual(readable.member);

    // The unread file may declare `Widget` too, so a unique readable sibling is not an answer.
    const { index } = packageMemberIndex({ ...input, unreadableFile: `${root}/pkg/Missing.java` });
    expect(resolveImported(index, importedName(anchor, "Widget"), "Widget")).toBeNull();
  });

  it("resolves a Kotlin package member from Java through the shared peer set", () => {
    const root = path.resolve("cg-sibling-package-kotlin-member").replace(/\\/g, "/");
    const anchor = `${root}/pkg/Anchor.java`;
    const sibling = `${root}/pkg/Sibling.kt`;
    const { index, member } = packageMemberIndex({
      anchor: { file: anchor, source: "package p;\nclass Anchor {}\n" },
      // Kotlin package clauses have no semicolon; the Kotlin module's own facts still name package `p`.
      sibling: { file: sibling, source: "package p\nclass Sibling { fun Widget() {} }\n" },
      exportedName: "Widget",
    });

    const resolved = resolveImported(index, importedName(anchor, "Widget"), "Widget");
    expect(resolved && "localName" in resolved ? resolved : null).toEqual(member);
  });
});
