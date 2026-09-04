import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { brotliDecompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { buildProjectIndex, buildProjectIndexIncremental, type BuildReport } from "../src/index.js";
import { PROJECT_SNAPSHOT_VERSION, tryLoadProjectIndexSnapshot } from "../src/indexer/build-cache/project-snapshot.js";
import { closeDiskCacheDatabase } from "../src/indexer/build-cache/module-cache.js";
import { loadManifest } from "../src/indexer/build-cache/manifest.js";
import { expandStarImports } from "../src/indexer/expand-star-imports.js";
import { SymbolKind, type ModuleIndex } from "../src/indexer/types.js";
import { fileIdentityKey, normalizePath } from "../src/util/paths.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const roots = createTempRootRegistry();

afterEach(async () => {
  await roots.cleanup();
});

function cacheDir(root: string): string {
  return path.join(root, ".codegraph", "cache", "index-v1");
}

function snapshotPath(root: string): string {
  return path.join(cacheDir(root), "project-index-snapshot.json");
}

function sqlitePath(root: string): string {
  return path.join(cacheDir(root), "index-cache.sqlite");
}

async function readSnapshot(root: string): Promise<{
  version: number;
  modules: Array<{ file: string }>;
  fileSignatures: Record<string, unknown>;
}> {
  const raw = await fsp.readFile(snapshotPath(root));
  return JSON.parse(brotliDecompressSync(raw).toString("utf8")) as {
    version: number;
    modules: Array<{ file: string }>;
    fileSignatures: Record<string, unknown>;
  };
}

function sqliteModuleFiles(root: string): Set<string> {
  const db = new DatabaseSync(sqlitePath(root));
  try {
    const rows = db.prepare("SELECT file FROM module_cache").all() as Array<{ file: string }>;
    return new Set(rows.map((row) => row.file));
  } finally {
    db.close();
  }
}

function sqliteModulePayloads(root: string): Array<{ file: string }> {
  const db = new DatabaseSync(sqlitePath(root));
  try {
    const rows = db.prepare("SELECT payload FROM module_cache").all() as Array<{ payload: Uint8Array }>;
    return rows.map((row) => JSON.parse(brotliDecompressSync(row.payload).toString("utf8")) as { file: string });
  } finally {
    db.close();
  }
}

function stepNames(report: BuildReport): string[] {
  return (report.timings?.steps ?? []).map((step) => step.name);
}

describe("thin project snapshot", () => {
  it("keeps SQLite-backed module bodies out of the snapshot and hydrates them on load", async () => {
    const root = await roots.create("cg-thin-snapshot-");
    await fsp.writeFile(path.join(root, "alpha.ts"), "export const alpha = 1;\n", "utf8");
    await fsp.writeFile(path.join(root, "beta.ts"), "export const beta = 1;\n", "utf8");
    await fsp.writeFile(path.join(root, "pkg.json"), "{}\n", "utf8");

    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const snapshot = await readSnapshot(root);
    const sqliteFiles = sqliteModuleFiles(root);

    expect(snapshot.version).toBe(PROJECT_SNAPSHOT_VERSION);
    expect(sqliteFiles.has("alpha.ts")).toBe(true);
    expect(sqliteFiles.has("beta.ts")).toBe(true);
    expect(snapshot.modules.some((module) => module.file === "alpha.ts" || module.file.endsWith("/alpha.ts"))).toBe(
      false,
    );
    expect(snapshot.modules.some((module) => module.file === "beta.ts" || module.file.endsWith("/beta.ts"))).toBe(
      false,
    );
    expect(snapshot.modules.length).toBeLessThan(index.byFile.size);

    const alpha = index.byFile.get(fileIdentityKey(normalizePath(path.join(root, "alpha.ts"))));
    expect(alpha?.locals.some((local) => local.localName === "alpha")).toBe(true);
  });

  it("does not re-serialize unchanged modules after a one-file edit, then hits the unchanged fast path", async () => {
    const root = await roots.create("cg-thin-snapshot-edit-");
    await fsp.writeFile(path.join(root, "alpha.ts"), "export const alpha = 1;\n", "utf8");
    await fsp.writeFile(path.join(root, "beta.ts"), "export const beta = 1;\n", "utf8");
    await buildProjectIndex(root, { cache: "disk", threads: 1 });

    await fsp.writeFile(path.join(root, "alpha.ts"), "export const alpha = 2;\n", "utf8");
    const incrementalReport: BuildReport = { timings: {} };
    const updated = await buildProjectIndexIncremental(root, { cache: "disk", threads: 1, report: incrementalReport });
    expect(stepNames(incrementalReport).includes("snapshot-write")).toBe(true);
    expect(
      updated.byFile
        .get(fileIdentityKey(normalizePath(path.join(root, "alpha.ts"))))
        ?.locals.some((local) => local.localName === "alpha"),
    ).toBe(true);
    const snapshot = await readSnapshot(root);
    expect(snapshot.modules.some((module) => module.file === "beta.ts" || module.file.endsWith("/beta.ts"))).toBe(
      false,
    );

    const warmReport: BuildReport = { timings: {} };
    const warm = await buildProjectIndexIncremental(root, { cache: "disk", threads: 1, report: warmReport });
    expect(warmReport.files?.parsed ?? 0).toBe(0);
    expect((warmReport.files?.cached ?? 0) > 0).toBe(true);
    expect(stepNames(warmReport).includes("snapshot-write")).toBe(false);
    expect(
      warm.byFile
        .get(fileIdentityKey(normalizePath(path.join(root, "alpha.ts"))))
        ?.locals.some((local) => local.localName === "alpha"),
    ).toBe(true);
  });

  it("drops a deleted file from snapshot identity and loaders", async () => {
    const root = await roots.create("cg-thin-snapshot-delete-");
    const gonePath = path.join(root, "gone.ts");
    await fsp.writeFile(path.join(root, "keep.ts"), "export const keep = 1;\n", "utf8");
    await fsp.writeFile(gonePath, "export const gone = 1;\n", "utf8");
    await buildProjectIndex(root, { cache: "disk", threads: 1 });
    await fsp.rm(gonePath);

    const updated = await buildProjectIndexIncremental(root, { cache: "disk", threads: 1 });
    expect(updated.byFile.has(fileIdentityKey(normalizePath(gonePath)))).toBe(false);
    expect(updated.byFile.has(fileIdentityKey(normalizePath(path.join(root, "keep.ts"))))).toBe(true);
    const snapshot = await readSnapshot(root);
    expect(Object.keys(snapshot.fileSignatures).some((file) => file.includes("gone.ts"))).toBe(false);
  });

  it("still loads a v10 snapshot that embeds module bodies", async () => {
    const root = await roots.create("cg-thin-snapshot-v10-");
    await fsp.writeFile(path.join(root, "alpha.ts"), "export const alpha = 1;\n", "utf8");
    await fsp.writeFile(path.join(root, "beta.ts"), "export const beta = 1;\n", "utf8");
    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const snapshot = await readSnapshot(root);
    const byFile = new Map<string, { file: string }>();
    for (const module of sqliteModulePayloads(root)) byFile.set(module.file, module);
    for (const module of snapshot.modules) byFile.set(module.file, module);
    const v10 = { ...snapshot, version: 10, modules: [...byFile.values()] };
    const { brotliCompressSync, constants } = await import("node:zlib");
    await fsp.writeFile(
      snapshotPath(root),
      brotliCompressSync(JSON.stringify(v10), { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }),
    );

    const manifest = await loadManifest(root, { cache: "disk" });
    if (!manifest) throw new Error("Expected manifest for v10 snapshot load.");
    const loaded = await tryLoadProjectIndexSnapshot(root, { cache: "disk" }, new Map(Object.entries(manifest.files)));
    expect(loaded).not.toBeNull();
    expect(loaded?.index.byFile.size).toBe(index.byFile.size);
    expect(
      loaded?.index.byFile
        .get(fileIdentityKey(normalizePath(path.join(root, "alpha.ts"))))
        ?.locals.some((local) => local.localName === "alpha"),
    ).toBe(true);
  });

  it("rebuilds quietly when SQLite module payloads are unreadable", async () => {
    const root = await roots.create("cg-thin-snapshot-sqlite-corrupt-");
    await fsp.writeFile(path.join(root, "alpha.ts"), "export const alpha = 1;\n", "utf8");
    await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const db = new DatabaseSync(sqlitePath(root));
    try {
      db.prepare("UPDATE module_cache SET payload = ?").run("{bad json");
    } finally {
      db.close();
    }
    const rebuilt = await buildProjectIndexIncremental(root, { cache: "disk", threads: 1 });
    expect(
      rebuilt.byFile
        .get(fileIdentityKey(normalizePath(path.join(root, "alpha.ts"))))
        ?.locals.some((local) => local.localName === "alpha"),
    ).toBe(true);
  });

  it("copies frozen modules before expanding star imports", () => {
    const libFile = normalizePath("/tmp/cg-star-lib.ts");
    const consumerFile = normalizePath("/tmp/cg-star-consumer.ts");
    const range = { start: { line: 1, column: 0 }, end: { line: 1, column: 3 } };
    const lib: ModuleIndex = {
      file: libFile,
      exports: [
        {
          type: "local",
          exportedAs: "foo",
          target: { file: libFile, localName: "foo", kind: SymbolKind.Function, range },
        },
      ],
      imports: [],
      locals: [{ file: libFile, localName: "foo", kind: SymbolKind.Function, range }],
    };
    const consumer: ModuleIndex = {
      file: consumerFile,
      exports: [],
      imports: [{ kind: "star", from: "./lib", resolved: libFile }],
      locals: [],
    };
    Object.freeze(lib);
    Object.freeze(lib.exports);
    Object.freeze(lib.locals);
    Object.freeze(consumer);
    Object.freeze(consumer.imports);
    const frozen = new Map<string, ModuleIndex>([
      [fileIdentityKey(libFile), lib],
      [fileIdentityKey(consumerFile), consumer],
    ]);
    expect(() => expandStarImports(frozen)).toThrow(TypeError);

    const owned = new Map<string, ModuleIndex>([
      [fileIdentityKey(libFile), lib],
      [
        fileIdentityKey(consumerFile),
        { ...consumer, exports: [...consumer.exports], imports: [...consumer.imports], locals: [...consumer.locals] },
      ],
    ]);
    expandStarImports(owned);
    expect(owned.get(fileIdentityKey(libFile))).toBe(lib);
    expect(
      owned
        .get(fileIdentityKey(consumerFile))
        ?.imports.some((binding) => binding.kind === "named" && binding.local === "foo"),
    ).toBe(true);
  });

  it("expands star imports after hydrating SQLite module bodies", async () => {
    const root = await roots.create("cg-thin-snapshot-star-");
    await fsp.writeFile(
      path.join(root, "Shared.cs"),
      "namespace Shared { public class Widget { public static int Value = 1; } }\n",
      "utf8",
    );
    await fsp.writeFile(path.join(root, "Consumer.cs"), "using Shared;\n", "utf8");
    await fsp.writeFile(path.join(root, "Other.cs"), "public class Other {}\n", "utf8");
    await buildProjectIndex(root, { cache: "disk", threads: 1 });

    const consumerKey = fileIdentityKey(normalizePath(path.join(root, "Consumer.cs")));
    const hasWidget = (index: {
      byFile: Map<string, { imports: Array<{ kind: string; imported?: string; local?: string }> }>;
    }): boolean =>
      Boolean(
        index.byFile
          .get(consumerKey)
          ?.imports.some((binding) => binding.kind === "named" && binding.local === "Widget"),
      );

    await fsp.writeFile(path.join(root, "Other.cs"), "public class Other { public static int Value = 2; }\n", "utf8");
    const updated = await buildProjectIndexIncremental(root, { cache: "disk", threads: 1 });
    expect(hasWidget(updated)).toBe(true);

    const manifest = await loadManifest(root, { cache: "disk" });
    if (!manifest) throw new Error("Expected manifest after star-import hydrate.");
    const loaded = await tryLoadProjectIndexSnapshot(root, { cache: "disk" }, new Map(Object.entries(manifest.files)));
    closeDiskCacheDatabase(root, { cache: "disk" });
    expect(loaded).not.toBeNull();
    if (!loaded) return;
    expect(hasWidget(loaded.index)).toBe(true);
  });
});
