import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { NativeBindingOrigin } from "../src/native/contracts.js";
import {
  lookupNativeRuntimeCacheEntry,
  prepareNativeRuntimeCache,
  recordNativeRuntimeCacheIdentity,
} from "../src/native/runtimeCache.js";
import { resolveCachedRuntimeIdentity, serializeNativeRuntimeFingerprint } from "../src/native/runtime.js";

const tempDirs: string[] = [];
const TARGET = "win32-x64-msvc";
const PACKAGE_NAME = `@lzehrung/codegraph-native-${TARGET}`;
const VERSION = "1.9.3";
const LANGUAGES = ["c", "go", "python", "rust", "ts"];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

type Fixture = {
  binaryPath: string;
  cacheRoot: string;
  emptyWorkspaceRoot: string;
  resolveFn: (specifier: string) => string;
};

async function makeFixture(bytes = "native-binary-contents"): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-native-identity-"));
  tempDirs.push(root);
  const platformRoot = path.join(root, "node_modules", "@lzehrung", `codegraph-native-${TARGET}`);
  const umbrellaEntry = path.join(root, "node_modules", "@lzehrung", "codegraph-native", "index.js");
  const binaryPath = path.join(platformRoot, `index.${TARGET}.node`);
  await fs.mkdir(platformRoot, { recursive: true });
  await fs.mkdir(path.dirname(umbrellaEntry), { recursive: true });
  await fs.writeFile(binaryPath, bytes);
  await fs.writeFile(path.join(platformRoot, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: VERSION }));
  await fs.writeFile(umbrellaEntry, "module.exports = {};\n");
  // resolveCachedRuntimeIdentity declines when a workspace binary exists, which it does in this
  // checkout, so point it at a directory that has none.
  const emptyWorkspaceRoot = path.join(root, "no-workspace-binary");
  await fs.mkdir(emptyWorkspaceRoot, { recursive: true });
  return {
    binaryPath,
    cacheRoot: path.join(root, "cache", "v1"),
    emptyWorkspaceRoot,
    resolveFn: (specifier: string) => {
      if (specifier === PACKAGE_NAME) return binaryPath;
      if (specifier === "@lzehrung/codegraph-native") return umbrellaEntry;
      throw new Error(`unexpected package resolution: ${specifier}`);
    },
  };
}

function prepare(fixture: Fixture, now?: number): ReturnType<typeof prepareNativeRuntimeCache> {
  return prepareNativeRuntimeCache({
    sourcePath: fixture.binaryPath,
    packageName: PACKAGE_NAME,
    packageVersion: VERSION,
    target: TARGET,
    cacheRoot: fixture.cacheRoot,
    ...(now === undefined ? {} : { now }),
  });
}

function originFor(result: {
  sourcePath: string;
  loadedPath: string;
  cacheKey: string;
  sha256: string;
}): NativeBindingOrigin {
  return {
    mode: "cache",
    packageName: PACKAGE_NAME,
    packageVersion: VERSION,
    target: TARGET,
    sourcePath: result.sourcePath,
    loadedPath: result.loadedPath,
    cacheKey: result.cacheKey,
    sha256: result.sha256,
  };
}

/** Record what a successful load would have recorded, so later calls can take the fast path. */
function recordLoad(result: { sourcePath: string; loadedPath: string; cacheKey: string; sha256: string }): void {
  recordNativeRuntimeCacheIdentity({
    sourcePath: result.sourcePath,
    loadedPath: result.loadedPath,
    cacheKey: result.cacheKey,
    sha256: result.sha256,
    verifiedAt: new Date().toISOString(),
    supportedLanguageIds: LANGUAGES,
    origin: originFor(result),
  });
}

/**
 * Replace a file's bytes, keeping its size, so only content differs. Recording the identity
 * afterwards produces the situation the stat-only fast path cannot detect: stats that match a
 * digest the bytes no longer have. If a later call still reports that digest, it did not hash.
 */
function rewriteContentOnly(filePath: string, bytes: string): void {
  const before = fsSync.statSync(filePath);
  if (Buffer.byteLength(bytes) !== before.size) {
    throw new Error(`replacement must preserve size: ${Buffer.byteLength(bytes)} vs ${before.size}`);
  }
  fsSync.writeFileSync(filePath, bytes);
}

describe("native runtime cache identity", () => {
  it("hashes on population and on every run until a load is recorded", async () => {
    const fixture = await makeFixture();

    const first = prepare(fixture);
    expect(first.status).toBe("cached");
    if (first.status === "unavailable") throw new Error(first.error.message);
    expect(first.verified).toBe(true);

    // No identity record yet, so the second run repeats both SHA-256 passes. This is the
    // behavior the fast path replaces, asserted so the next test means something.
    const second = prepare(fixture);
    if (second.status === "unavailable") throw new Error(second.error.message);
    expect(second.status).toBe("reused");
    expect(second.verified).toBe(true);
  });

  it("reuses a recorded identity without hashing either file", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);

    // Swap the cached bytes, then record the identity, so the stored stats describe the file as
    // it now is while the stored digest describes what it used to be. Hashing would catch the
    // mismatch and rebuild the entry; the fast path is defined not to look.
    rewriteContentOnly(populated.loadedPath, "tampered-bin-contents!");
    recordLoad(populated);

    const reused = prepare(fixture);
    if (reused.status === "unavailable") throw new Error(reused.error.message);
    expect(reused.status).toBe("reused");
    expect(reused.verified).toBe(false);
    expect(reused.sha256).toBe(populated.sha256);
    expect(reused.loadedPath).toBe(populated.loadedPath);
  });

  it("hashes again once the identity record passes its re-verification interval", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);
    rewriteContentOnly(populated.loadedPath, "tampered-bin-contents!");
    recordLoad(populated);

    const expired = prepare(fixture, Date.now() + 25 * 60 * 60 * 1000);
    if (expired.status === "unavailable") throw new Error(expired.error.message);
    // Past the TTL the files are hashed, the substitution is detected, and the entry is rebuilt
    // from the source rather than trusted.
    expect(expired.verified).toBe(true);
    expect(expired.sha256).toBe(populated.sha256);
    expect(fsSync.readFileSync(expired.loadedPath, "utf8")).toBe("native-binary-contents");
  });

  it("falls back to hashing when the source binary changes underneath the record", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);
    recordLoad(populated);

    await fs.writeFile(fixture.binaryPath, "a-different-native-binary");
    const rebuilt = prepare(fixture);
    if (rebuilt.status === "unavailable") throw new Error(rebuilt.error.message);
    expect(rebuilt.verified).toBe(true);
    expect(rebuilt.sha256).not.toBe(populated.sha256);
  });

  it("falls back to hashing when the cached copy changes size", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);
    recordLoad(populated);

    fsSync.writeFileSync(populated.loadedPath, "short");
    const rebuilt = prepare(fixture);
    if (rebuilt.status === "unavailable") throw new Error(rebuilt.error.message);
    expect(rebuilt.verified).toBe(true);
    expect(fsSync.readFileSync(rebuilt.loadedPath, "utf8")).toBe("native-binary-contents");
  });

  it("ignores a malformed identity record instead of trusting it", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);
    recordLoad(populated);

    const identityPath = path.join(path.dirname(populated.loadedPath), "identity.json");
    await fs.writeFile(identityPath, '{"version":1,"sha256":');
    expect(
      lookupNativeRuntimeCacheEntry({
        sourcePath: fixture.binaryPath,
        packageVersion: VERSION,
        target: TARGET,
        cacheRoot: fixture.cacheRoot,
      }),
    ).toBeNull();

    const rebuilt = prepare(fixture);
    if (rebuilt.status === "unavailable") throw new Error(rebuilt.error.message);
    expect(rebuilt.verified).toBe(true);
  });

  it("declines a record left by another install of the same version", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);
    recordLoad(populated);

    // A second project with the same package version installed. npm can produce byte-identical
    // files, and tarball extraction can give them the same mtime, so size and mtime alone would
    // match the first project's record - and hand this build the other project's source path,
    // which travels into the binding origin and changes the runtime fingerprint.
    //
    // The record's stat fields are set from the sibling rather than copying mtimes between
    // files, because utimesSync truncates sub-millisecond precision: the lookup would then
    // decline on the mtime and this test would pass without ever reaching the path comparison.
    const sibling = await makeFixture();
    const siblingStats = fsSync.statSync(sibling.binaryPath);
    const identityPath = path.join(path.dirname(populated.loadedPath), "identity.json");
    const identity = JSON.parse(await fs.readFile(identityPath, "utf8")) as {
      sourcePath: string;
      sourceSize: number;
      sourceMtimeMs: number;
    };
    identity.sourceSize = siblingStats.size;
    identity.sourceMtimeMs = siblingStats.mtimeMs;
    await fs.writeFile(identityPath, JSON.stringify(identity));
    // Everything the lookup compares now matches except which install the record describes.
    expect(identity.sourcePath).not.toBe(fsSync.realpathSync.native(sibling.binaryPath));

    expect(
      lookupNativeRuntimeCacheEntry({
        sourcePath: sibling.binaryPath,
        packageVersion: VERSION,
        target: TARGET,
        cacheRoot: fixture.cacheRoot,
      }),
    ).toBeNull();

    // Restoring only the path proves the path is what declined it: the same record, the same
    // stat values, now naming this install, is accepted.
    identity.sourcePath = fsSync.realpathSync.native(sibling.binaryPath);
    await fs.writeFile(identityPath, JSON.stringify(identity));
    expect(
      lookupNativeRuntimeCacheEntry({
        sourcePath: sibling.binaryPath,
        packageVersion: VERSION,
        target: TARGET,
        cacheRoot: fixture.cacheRoot,
      }),
    ).not.toBeNull();
  });

  it("declines a record written by a runtime that cannot load it here", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);
    recordLoad(populated);

    const identityPath = path.join(path.dirname(populated.loadedPath), "identity.json");
    const identity = JSON.parse(await fs.readFile(identityPath, "utf8")) as { runtime: { abi: string } };
    expect(identity.runtime.abi).toBe(process.versions.modules);

    // A major Node upgrade changes the addon ABI: the bytes are untouched, every stat still
    // matches, and the file no longer loads. Reporting it as available would stamp an index as
    // natively built when the build actually fell back.
    identity.runtime.abi = `${Number(process.versions.modules) + 1}`;
    await fs.writeFile(identityPath, JSON.stringify(identity));

    expect(
      lookupNativeRuntimeCacheEntry({
        sourcePath: fixture.binaryPath,
        packageVersion: VERSION,
        target: TARGET,
        cacheRoot: fixture.cacheRoot,
      }),
    ).toBeNull();

    const rebuilt = prepare(fixture);
    if (rebuilt.status === "unavailable") throw new Error(rebuilt.error.message);
    expect(rebuilt.verified).toBe(true);
  });

  it("keeps working for an entry written before identity records existed", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);
    recordLoad(populated);

    // An entry produced by the previous implementation: manifest.json and the binary, no
    // identity.json. It must still resolve, just without the fast path.
    const entryPath = path.dirname(populated.loadedPath);
    await fs.rm(path.join(entryPath, "identity.json"));
    expect(fsSync.existsSync(path.join(entryPath, "manifest.json"))).toBe(true);

    const legacy = prepare(fixture);
    if (legacy.status === "unavailable") throw new Error(legacy.error.message);
    expect(legacy.status).toBe("reused");
    expect(legacy.verified).toBe(true);
    expect(legacy.sha256).toBe(populated.sha256);
    expect(legacy.loadedPath).toBe(populated.loadedPath);
  });
});

describe("native cache pruning", () => {
  const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

  async function fixtureAtVersion(version: string, bytes: string, cacheRoot: string): Promise<Fixture> {
    const fixture = await makeFixture(bytes);
    await fs.writeFile(
      path.join(path.dirname(fixture.binaryPath), "package.json"),
      JSON.stringify({ name: PACKAGE_NAME, version }),
    );
    return { ...fixture, cacheRoot };
  }

  function prepareAt(fixture: Fixture, version: string, now?: number): ReturnType<typeof prepareNativeRuntimeCache> {
    return prepareNativeRuntimeCache({
      sourcePath: fixture.binaryPath,
      packageName: PACKAGE_NAME,
      packageVersion: version,
      target: TARGET,
      cacheRoot: fixture.cacheRoot,
      ...(now === undefined ? {} : { now }),
    });
  }

  function entryNames(cacheRoot: string): string[] {
    return fsSync.readdirSync(path.join(cacheRoot, TARGET)).sort();
  }

  it("keeps entries for other versions that are still in use", async () => {
    const shared = await makeFixture();
    const cacheRoot = shared.cacheRoot;

    // The cache root is per-user and shared by every project on the machine. Two projects pinned
    // to different native versions must not delete each other's entry, which is what pruning by
    // "not the version installing right now" would do on every run.
    const other = await fixtureAtVersion("1.9.0", "other-binary-contents", cacheRoot);
    const otherEntry = prepareAt(other, "1.9.0");
    if (otherEntry.status === "unavailable") throw new Error(otherEntry.error.message);

    const current = await fixtureAtVersion(VERSION, "current-binary-contents", cacheRoot);
    const currentEntry = prepareAt(current, VERSION);
    if (currentEntry.status === "unavailable") throw new Error(currentEntry.error.message);

    expect(entryNames(cacheRoot)).toEqual(
      [path.basename(path.dirname(otherEntry.loadedPath)), path.basename(path.dirname(currentEntry.loadedPath))].sort(),
    );
    expect(fsSync.readFileSync(otherEntry.loadedPath, "utf8")).toBe("other-binary-contents");
  });

  it("removes entries no project has used for a month", async () => {
    const shared = await makeFixture();
    const cacheRoot = shared.cacheRoot;

    const abandoned = await fixtureAtVersion("1.9.0", "other-binary-contents", cacheRoot);
    const abandonedEntry = prepareAt(abandoned, "1.9.0");
    if (abandonedEntry.status === "unavailable") throw new Error(abandonedEntry.error.message);

    const current = await fixtureAtVersion(VERSION, "current-binary-contents", cacheRoot);
    // Install far enough in the future that the other entry is past its retention window. An
    // entry in use is re-verified within a day, so age is what separates abandoned from active.
    const currentEntry = prepareAt(current, VERSION, Date.now() + RETENTION_MS + 60_000);
    if (currentEntry.status === "unavailable") throw new Error(currentEntry.error.message);

    expect(entryNames(cacheRoot)).toEqual([path.basename(path.dirname(currentEntry.loadedPath))]);
    expect(fsSync.readFileSync(currentEntry.loadedPath, "utf8")).toBe("current-binary-contents");
  });

  it("keeps entries it cannot identify and the one it just wrote", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);

    // A directory with no readable manifest looks exactly like another process part-way through
    // populating an entry, so removing it would be a race, not a cleanup.
    const targetPath = path.join(fixture.cacheRoot, TARGET);
    const partial = path.join(targetPath, "9.9.9-partial");
    await fs.mkdir(partial, { recursive: true });
    await fs.writeFile(path.join(partial, "manifest.json"), "{not json");

    const again = await fixtureAtVersion("2.0.0", "next-major-contents-x", fixture.cacheRoot);
    const upgraded = prepareAt(again, "2.0.0", Date.now() + RETENTION_MS + 60_000);
    if (upgraded.status === "unavailable") throw new Error(upgraded.error.message);

    const remaining = entryNames(fixture.cacheRoot);
    expect(remaining).toContain("9.9.9-partial");
    expect(remaining).toContain(path.basename(path.dirname(upgraded.loadedPath)));
    // The 1.9.3 entry was datable and long unused, so it went.
    expect(remaining).not.toContain(path.basename(path.dirname(populated.loadedPath)));
  });

  it("does not prune on a fast-path hit, which installs nothing", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);
    recordLoad(populated);

    const targetPath = path.join(fixture.cacheRoot, TARGET);
    const stale = path.join(targetPath, "1.0.0-stale");
    await fs.mkdir(stale, { recursive: true });
    await fs.writeFile(
      path.join(stale, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        packageName: PACKAGE_NAME,
        packageVersion: "1.0.0",
        cachedAt: "2020-01-01T00:00:00.000Z",
      }),
    );

    const reused = prepare(fixture);
    if (reused.status === "unavailable") throw new Error(reused.error.message);
    expect(reused.verified).toBe(false);
    // Nothing was installed, so the warm run did no directory work even though the stale entry
    // is far past its retention window.
    expect(entryNames(fixture.cacheRoot)).toContain("1.0.0-stale");
  });
});

describe("runtime fingerprint without loading the addon", () => {
  it("answers from a recorded identity", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);
    recordLoad(populated);

    const identity = resolveCachedRuntimeIdentity({
      platform: "win32",
      arch: "x64",
      localPackageRoot: fixture.emptyWorkspaceRoot,
      resolveFn: fixture.resolveFn,
      cacheRoot: fixture.cacheRoot,
    });

    expect(identity).toEqual({
      available: true,
      supportedLanguageIds: LANGUAGES,
      origin: originFor(populated),
    });
  });

  it("produces the same fingerprint a loaded binding would", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);
    recordLoad(populated);

    const fromCache = resolveCachedRuntimeIdentity({
      platform: "win32",
      arch: "x64",
      localPackageRoot: fixture.emptyWorkspaceRoot,
      resolveFn: fixture.resolveFn,
      cacheRoot: fixture.cacheRoot,
    });
    if (!fromCache) throw new Error("expected a recorded identity");

    // What loadBinding() would have produced for the same entry: the addon reports its languages
    // and the loader reports this origin. Equal inputs must serialize to an equal fingerprint,
    // or turning the fast path on would invalidate every existing on-disk index.
    const fromLoad = {
      available: true,
      supportedLanguageIds: [...LANGUAGES].sort(),
      origin: originFor(populated),
    };
    expect(serializeNativeRuntimeFingerprint("auto", false, fromCache)).toBe(
      serializeNativeRuntimeFingerprint("auto", false, fromLoad),
    );
  });

  it("declines outside the platforms and layouts that populate the cache", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);
    recordLoad(populated);

    const base = {
      arch: "x64",
      localPackageRoot: fixture.emptyWorkspaceRoot,
      resolveFn: fixture.resolveFn,
      cacheRoot: fixture.cacheRoot,
    };
    // No runtime cache off Windows.
    expect(resolveCachedRuntimeIdentity({ ...base, platform: "linux" })).toBeUndefined();
    // A workspace checkout resolves its own binary, so the installed entry must not answer for it.
    expect(
      resolveCachedRuntimeIdentity({
        ...base,
        platform: "win32",
        localPackageRoot: path.resolve("packages/codegraph-native"),
      }),
    ).toBeUndefined();
    // An empty cache root has nothing to replay.
    expect(resolveCachedRuntimeIdentity({ ...base, platform: "win32", cacheRoot: fixture.emptyWorkspaceRoot })).toBe(
      undefined,
    );
  });
});
