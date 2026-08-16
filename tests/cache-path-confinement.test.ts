import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

import { buildProjectIndex } from "../src/index.js";
import type { ModuleIndex } from "../src/indexer/types.js";
import {
  cacheDatabasePath,
  cacheRelativePath,
  clearMemoryCache,
  closeDiskCacheDatabase,
  tryLoadFromCache,
  writeToCache,
} from "../src/indexer/build-cache/module-cache.js";
import { loadManifest } from "../src/indexer/build-cache/manifest.js";
import {
  tryLoadPersistedBloomFilters,
  tryLoadProjectIndexSnapshot,
} from "../src/indexer/build-cache/project-snapshot.js";
import { mkTmpDir } from "./helpers/filesystem.js";

function moduleFor(file: string): ModuleIndex {
  return {
    file,
    exports: [],
    imports: [],
    locals: [
      { file, localName: "value", kind: 1, range: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
    ],
  };
}

function snapshotPathFor(root: string): string {
  return path.join(root, ".codegraph-cache", "index-v1", "project-index-snapshot.json");
}

describe("persisted cache rehydration is confined to the project root", () => {
  it("rejects module cache rows whose persisted relative file path escapes the project root", async () => {
    const root = await mkTmpDir("dg-confine-module-");
    const file = path.join(root, "a.ts");
    const sig = "sig-traversal";

    writeToCache(root, file, sig, moduleFor(file), { cache: "disk" });
    closeDiskCacheDatabase(root, { cache: "disk" });

    const dbPath = cacheDatabasePath(root, { cache: "disk" }, "index-cache.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      const maliciousModule: ModuleIndex = {
        file: "../outside.ts",
        exports: [],
        imports: [],
        locals: [],
      };
      const maliciousPayload = brotliCompressSync(Buffer.from(JSON.stringify(maliciousModule)));
      db.prepare("UPDATE module_cache SET payload = ? WHERE file = ?").run(
        maliciousPayload,
        cacheRelativePath(root, file),
      );
    } finally {
      db.close();
    }

    // The confinement helper must reject the row before its path is ever rehydrated into a
    // module, so this must read back as a clean cache miss rather than an escaped absolute path.
    expect(tryLoadFromCache(root, file, sig, { cache: "disk" })).toBeNull();

    closeDiskCacheDatabase(root, { cache: "disk" });
    clearMemoryCache();
  });

  it("rejects module cache imports whose resolved relative path escapes the project root", async () => {
    const root = await mkTmpDir("dg-confine-module-import-");
    const file = path.join(root, "a.ts");
    const sig = "sig-traversal-import";

    writeToCache(root, file, sig, moduleFor(file), { cache: "disk" });
    closeDiskCacheDatabase(root, { cache: "disk" });

    const dbPath = cacheDatabasePath(root, { cache: "disk" }, "index-cache.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      const maliciousModule: ModuleIndex = {
        file: "a.ts",
        exports: [],
        locals: [],
        imports: [
          {
            kind: "default",
            local: "outside",
            from: "../outside.ts",
            resolved: "../../outside.ts",
          },
        ],
      };
      const maliciousPayload = brotliCompressSync(Buffer.from(JSON.stringify(maliciousModule)));
      db.prepare("UPDATE module_cache SET payload = ? WHERE file = ?").run(
        maliciousPayload,
        cacheRelativePath(root, file),
      );
    } finally {
      db.close();
    }

    expect(tryLoadFromCache(root, file, sig, { cache: "disk" })).toBeNull();

    closeDiskCacheDatabase(root, { cache: "disk" });
    clearMemoryCache();
  });

  it("rejects module cache reexports whose persisted target path escapes the project root", async () => {
    const root = await mkTmpDir("dg-confine-module-reexport-");
    const file = path.join(root, "barrel.ts");
    const sig = "sig-traversal-reexport";

    writeToCache(root, file, sig, moduleFor(file), { cache: "disk" });
    closeDiskCacheDatabase(root, { cache: "disk" });

    const dbPath = cacheDatabasePath(root, { cache: "disk" }, "index-cache.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      const maliciousModule: ModuleIndex = {
        file: "barrel.ts",
        exports: [
          {
            type: "reexport",
            exportedAs: "outside",
            fromModule: "../../outside.ts",
            sourceSpecifier: "./outside",
          },
        ],
        imports: [],
        locals: [],
      };
      const maliciousPayload = brotliCompressSync(Buffer.from(JSON.stringify(maliciousModule)));
      db.prepare("UPDATE module_cache SET payload = ? WHERE file = ?").run(
        maliciousPayload,
        cacheRelativePath(root, file),
      );
    } finally {
      db.close();
    }

    expect(tryLoadFromCache(root, file, sig, { cache: "disk" })).toBeNull();

    closeDiskCacheDatabase(root, { cache: "disk" });
    clearMemoryCache();
  });

  it("preserves unresolved external reexports through a module-cache round trip", async () => {
    const root = await mkTmpDir("dg-confine-module-external-reexport-");
    const file = path.join(root, "barrel.ts");
    const sig = "sig-external-reexport";
    const externalSpecifier = "external-package/subpath";
    const module: ModuleIndex = {
      file,
      exports: [
        {
          type: "reexport",
          exportedAs: "externalValue",
          fromModule: externalSpecifier,
          sourceSpecifier: "externalValue",
        },
      ],
      imports: [],
      locals: [],
    };

    writeToCache(root, file, sig, module, { cache: "disk" });
    const loaded = tryLoadFromCache(root, file, sig, { cache: "disk" });
    const reexport = loaded?.exports.find((entry) => entry.type === "reexport");

    expect(reexport?.type).toBe("reexport");
    if (reexport?.type === "reexport") {
      expect(reexport.fromModule).toBe(externalSpecifier);
      expect(reexport.moduleSpecifier).toBe(externalSpecifier);
    }

    closeDiskCacheDatabase(root, { cache: "disk" });
    clearMemoryCache();
  });

  it("rejects a persisted project snapshot whose projectFiles escape the project root", async () => {
    const root = await mkTmpDir("dg-confine-snapshot-projectfiles-");
    await fsp.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
    await buildProjectIndex(root, { cache: "disk", threads: 1 });

    const snapshotPath = snapshotPathFor(root);
    const raw = await fsp.readFile(snapshotPath);
    const payload = JSON.parse(brotliDecompressSync(raw).toString("utf8")) as {
      projectFiles?: Array<Record<string, unknown>>;
    };
    payload.projectFiles = [
      { path: "../../outside.ts", kind: "file", type: "node", role: "manifest", projectRoot: "." },
    ];
    await fsp.writeFile(snapshotPath, brotliCompressSync(Buffer.from(JSON.stringify(payload))));

    // A confined rehydration must discard the whole snapshot rather than silently accepting an
    // out-of-root entry, so the rebuild must not surface the smuggled path anywhere in the index.
    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const projectFilePaths = (index.projectFiles ?? []).map((entry) => entry.path);
    expect(projectFilePaths.some((filePath) => filePath.includes("outside.ts"))).toBe(false);
    expect([...index.byFile.keys()].some((file) => file.endsWith("a.ts"))).toBe(true);
  });

  it("rejects a persisted project snapshot whose graph paths escape the project root", async () => {
    const root = await mkTmpDir("dg-confine-snapshot-graph-");
    await fsp.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
    await buildProjectIndex(root, { cache: "disk", threads: 1 });

    const snapshotPath = snapshotPathFor(root);
    const raw = await fsp.readFile(snapshotPath);
    const payload = JSON.parse(brotliDecompressSync(raw).toString("utf8")) as {
      graph?: { nodes?: string[] };
    };
    if (!payload.graph) throw new Error("Expected the persisted snapshot graph.");
    payload.graph.nodes = ["../../outside.ts"];
    await fsp.writeFile(snapshotPath, brotliCompressSync(Buffer.from(JSON.stringify(payload))));

    // Snapshot graph paths are rehydrated before the warm index is returned, so an escaped
    // node rejects the snapshot and forces a root-confined rebuild.
    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    expect([...index.graph.nodes].some((file) => file.includes("outside.ts"))).toBe(false);
    expect([...index.byFile.keys()].some((file) => file.endsWith("a.ts"))).toBe(true);
  });

  it("rejects a persisted project snapshot whose reexport target escapes the project root", async () => {
    const root = await mkTmpDir("dg-confine-snapshot-reexport-");
    await fsp.writeFile(path.join(root, "dependency.ts"), "export const dependency = 1;\n", "utf8");
    await fsp.writeFile(path.join(root, "barrel.ts"), "export { dependency } from './dependency';\n", "utf8");
    await buildProjectIndex(root, { cache: "disk", threads: 1 });

    const snapshotPath = snapshotPathFor(root);
    const raw = await fsp.readFile(snapshotPath);
    const payload = JSON.parse(brotliDecompressSync(raw).toString("utf8")) as {
      modules?: Array<{ file?: string; exports?: Array<Record<string, unknown>> }>;
    };
    const barrel = payload.modules?.find((module) => module.file === "barrel.ts");
    const reexport = barrel?.exports?.find((entry) => entry.type === "reexport");
    if (!reexport) throw new Error("Expected the persisted barrel reexport.");
    reexport.fromModule = "../../outside.ts";
    await fsp.writeFile(snapshotPath, brotliCompressSync(Buffer.from(JSON.stringify(payload))));

    const index = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const barrelModule = [...index.byFile.values()].find((module) => module.file.endsWith("barrel.ts"));
    const rebuiltReexport = barrelModule?.exports.find((entry) => entry.type === "reexport");
    expect(rebuiltReexport?.type).toBe("reexport");
    if (rebuiltReexport?.type === "reexport") {
      expect(rebuiltReexport.fromModule).not.toContain("outside.ts");
    }
  });

  it("preserves unresolved external reexports through a project-snapshot round trip", async () => {
    const root = await mkTmpDir("dg-confine-snapshot-external-reexport-");
    const externalSpecifier = "external-package/subpath";
    await fsp.writeFile(
      path.join(root, "barrel.ts"),
      `export { externalValue } from "${externalSpecifier}";\n`,
      "utf8",
    );
    await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const manifest = await loadManifest(root, { cache: "disk" });
    if (!manifest) throw new Error("Expected manifest for persisted snapshot.");

    const snapshot = await tryLoadProjectIndexSnapshot(
      root,
      { cache: "disk", threads: 1 },
      new Map(Object.entries(manifest.files)),
    );
    const barrel = [...(snapshot?.index.byFile.values() ?? [])].find((module) => module.file.endsWith("barrel.ts"));
    const reexport = barrel?.exports.find((entry) => entry.type === "reexport");

    expect(reexport?.type).toBe("reexport");
    if (reexport?.type === "reexport") expect(reexport.fromModule).toBe(externalSpecifier);
  });

  it("rejects manifest file keys that escape the project root before cache probes", async () => {
    const root = await mkTmpDir("dg-confine-manifest-key-");
    await fsp.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
    await buildProjectIndex(root, { cache: "disk", threads: 1 });

    const manifestPath = path.join(root, ".codegraph-cache", "index-v1", "manifest.json");
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as { files?: Record<string, unknown> };
    manifest.files = { "../../outside.ts": { sig: "tampered", edges: [] } };
    await fsp.writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    expect(await loadManifest(root, { cache: "disk" })).toBeNull();
  });

  it("rejects persisted bloom filters keyed by a path that escapes the project root", async () => {
    const root = await mkTmpDir("dg-confine-bloom-");
    await fsp.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
    await buildProjectIndex(root, { cache: "disk", threads: 1, useBloomFilters: true });

    const snapshotPath = snapshotPathFor(root);
    const raw = await fsp.readFile(snapshotPath);
    const payload = JSON.parse(brotliDecompressSync(raw).toString("utf8")) as {
      bloomFilters?: Record<string, unknown>;
    };
    const sampleFilter = Object.values(payload.bloomFilters ?? {})[0];
    expect(sampleFilter).toBeDefined();
    payload.bloomFilters = { "../../outside.ts": sampleFilter };
    await fsp.writeFile(snapshotPath, brotliCompressSync(Buffer.from(JSON.stringify(payload))));

    // The bloom-only fast path reads this section directly, bypassing the whole-snapshot
    // transform, so it must apply the same confinement check on its own before reuse.
    const bloomFilters = await tryLoadPersistedBloomFilters(root, { cache: "disk" });
    expect(bloomFilters).toBeNull();
  });
});
