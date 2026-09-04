import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProjectIndex, buildProjectIndexIncremental } from "../src/index.js";
import {
  MANIFEST_VERSION,
  loadManifest,
  writeManifest,
  type IndexManifest,
} from "../src/indexer/build-cache/manifest.js";
import { closeDiskCacheDatabase } from "../src/indexer/build-cache/module-cache.js";
import { fileIdentityKey, normalizePath } from "../src/util/paths.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const roots = createTempRootRegistry();

afterEach(async () => {
  await roots.cleanup();
});

function manifestPathFor(root: string): string {
  return path.join(root, ".codegraph", "cache", "index-v1", "manifest.json");
}

function createManifest(root: string): IndexManifest {
  return {
    version: MANIFEST_VERSION,
    projectRoot: normalizePath(path.resolve(root)),
    updatedAt: Date.now(),
    buildOptions: { implementationFingerprint: "a".repeat(64) },
    files: {},
  };
}

function isCompactJson(raw: string): boolean {
  return raw === JSON.stringify(JSON.parse(raw));
}

describe("compact index manifest", () => {
  it("writes compact JSON without bumping the manifest version", async () => {
    const root = await roots.create("cg-compact-manifest-write-");
    const written = await writeManifest(root, undefined, createManifest(root));
    expect(written).toBe(true);

    const raw = await fsp.readFile(manifestPathFor(root), "utf8");
    expect(isCompactJson(raw)).toBe(true);
    expect(raw.includes("\n")).toBe(false);

    const loaded = await loadManifest(root);
    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(MANIFEST_VERSION);
    expect(loaded?.projectRoot).toBe(normalizePath(path.resolve(root)));
  });

  it("still loads pretty-printed index manifests from earlier versions", async () => {
    const root = await roots.create("cg-compact-manifest-pretty-load-");
    const manifest = createManifest(root);
    const pretty = JSON.stringify(manifest, null, 2);
    expect(pretty.includes("\n")).toBe(true);
    expect(isCompactJson(pretty)).toBe(false);

    await fsp.mkdir(path.dirname(manifestPathFor(root)), { recursive: true });
    await fsp.writeFile(manifestPathFor(root), pretty, "utf8");

    const loaded = await loadManifest(root);
    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(MANIFEST_VERSION);
    expect(loaded?.projectRoot).toBe(manifest.projectRoot);
    expect(loaded?.updatedAt).toBe(manifest.updatedAt);
  });

  it("rewrites a pretty index manifest compactly on the next write", async () => {
    const root = await roots.create("cg-compact-manifest-rewrite-");
    const manifest = createManifest(root);
    await fsp.mkdir(path.dirname(manifestPathFor(root)), { recursive: true });
    await fsp.writeFile(manifestPathFor(root), JSON.stringify(manifest, null, 2), "utf8");
    expect(isCompactJson(await fsp.readFile(manifestPathFor(root), "utf8"))).toBe(false);

    const written = await writeManifest(root, undefined, manifest);
    expect(written).toBe(true);
    const raw = await fsp.readFile(manifestPathFor(root), "utf8");
    expect(isCompactJson(raw)).toBe(true);
    expect(JSON.parse(raw)).toEqual(manifest);
  });

  it("keeps incremental disk-cache updates working after a compact rewrite", async () => {
    const root = await roots.create("cg-compact-manifest-incremental-");
    const alpha = path.join(root, "alpha.ts");
    const beta = path.join(root, "beta.ts");
    await fsp.writeFile(alpha, "export const alpha = 1;\n", "utf8");
    await fsp.writeFile(beta, "export const beta = 1;\n", "utf8");

    await buildProjectIndex(root, { cache: "disk", threads: 1 });
    const afterBuild = await fsp.readFile(manifestPathFor(root), "utf8");
    expect(isCompactJson(afterBuild)).toBe(true);
    expect((JSON.parse(afterBuild) as { version: number }).version).toBe(MANIFEST_VERSION);

    await fsp.writeFile(manifestPathFor(root), JSON.stringify(JSON.parse(afterBuild), null, 2), "utf8");
    expect(isCompactJson(await fsp.readFile(manifestPathFor(root), "utf8"))).toBe(false);

    await fsp.writeFile(alpha, "export const alpha = 2;\n", "utf8");
    const updated = await buildProjectIndexIncremental(root, { cache: "disk", threads: 1 });
    closeDiskCacheDatabase(root, { cache: "disk" });

    const afterUpdate = await fsp.readFile(manifestPathFor(root), "utf8");
    expect(isCompactJson(afterUpdate)).toBe(true);
    expect((JSON.parse(afterUpdate) as { version: number }).version).toBe(MANIFEST_VERSION);
    expect(
      updated.byFile.get(fileIdentityKey(normalizePath(alpha)))?.locals.some((local) => local.localName === "alpha"),
    ).toBe(true);
    expect(
      updated.byFile.get(fileIdentityKey(normalizePath(beta)))?.locals.some((local) => local.localName === "beta"),
    ).toBe(true);
  });
});
