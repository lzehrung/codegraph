import fs from "node:fs";
import fsp from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildProjectIndex, resolveExport, resolveImported } from "../src/index.js";
import type { ImportBinding, ProjectIndex } from "../src/indexer/types.js";
import { createTempProjectRoot } from "./helpers/filesystem.js";
import { expectResolvedDef } from "./helpers/narrow.js";

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
});
