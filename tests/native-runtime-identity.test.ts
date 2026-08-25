import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { NativeBindingOrigin } from "../src/native/contracts.js";
import * as runtimeCache from "../src/native/runtimeCache.js";
import {
  lookupNativeRuntimeCacheEntry,
  prepareNativeRuntimeCache,
  recordNativeRuntimeCacheIdentity,
} from "../src/native/runtimeCache.js";
import {
  __resetNativeTreeSitterBindingForTests,
  getNativeRuntimeFingerprint,
  resolveCachedRuntimeIdentity,
  serializeNativeRuntimeFingerprint,
} from "../src/native/runtime.js";
import * as bindingLoader from "../src/native/bindingLoader.js";

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
function identityPathFor(result: { sourcePath: string; loadedPath: string }): string {
  const sourcePath = fsSync.realpathSync.native(result.sourcePath);
  const sourceKey = createHash("sha256").update(sourcePath).digest("hex");
  return path.join(path.dirname(result.loadedPath), `identity-${sourceKey}.json`);
}

function recordLoad(result: {
  sourcePath: string;
  loadedPath: string;
  cacheKey: string;
  sha256: string;
  sourceSize: number;
  sourceMtimeMs: number;
  cachedSize: number;
  cachedMtimeMs: number;
}): void {
  recordNativeRuntimeCacheIdentity({
    sourcePath: result.sourcePath,
    loadedPath: result.loadedPath,
    cacheKey: result.cacheKey,
    sha256: result.sha256,
    sourceSize: result.sourceSize,
    sourceMtimeMs: result.sourceMtimeMs,
    cachedSize: result.cachedSize,
    cachedMtimeMs: result.cachedMtimeMs,
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
    recordLoad(populated);
    rewriteContentOnly(populated.loadedPath, "tampered-bin-contents!");

    // This simulates the stat-preserving substitution the TTL bounds. Production only creates
    // this record from the verified snapshot, so it cannot accidentally create this state.
    const identityPath = identityPathFor(populated);
    const identity = JSON.parse(await fs.readFile(identityPath, "utf8")) as {
      cachedSize: number;
      cachedMtimeMs: number;
    };
    const cachedStats = fsSync.statSync(populated.loadedPath);
    identity.cachedSize = cachedStats.size;
    identity.cachedMtimeMs = cachedStats.mtimeMs;
    await fs.writeFile(identityPath, JSON.stringify(identity));

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

  it("declines an identity that points outside its immutable cache entry", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);
    recordLoad(populated);

    const foreignPath = path.join(fixture.cacheRoot, TARGET, "foreign-addon.node");
    await fs.copyFile(populated.loadedPath, foreignPath);
    const foreignStats = fsSync.statSync(foreignPath);
    const identityPath = identityPathFor(populated);
    const identity = JSON.parse(await fs.readFile(identityPath, "utf8")) as {
      loadedPath: string;
      cachedSize: number;
      cachedMtimeMs: number;
      origin: { loadedPath: string };
    };
    identity.loadedPath = foreignPath;
    identity.cachedSize = foreignStats.size;
    identity.cachedMtimeMs = foreignStats.mtimeMs;
    identity.origin.loadedPath = foreignPath;
    await fs.writeFile(identityPath, JSON.stringify(identity));

    expect(
      lookupNativeRuntimeCacheEntry({
        sourcePath: fixture.binaryPath,
        packageName: PACKAGE_NAME,
        packageVersion: VERSION,
        target: TARGET,
        cacheRoot: fixture.cacheRoot,
      }),
    ).toBeNull();
  });

  it("declines to record an identity after verified source bytes change", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);

    rewriteContentOnly(fixture.binaryPath, "tampered-bin-contents!");
    const afterVerification = new Date(Date.now() + 1_000);
    fsSync.utimesSync(fixture.binaryPath, afterVerification, afterVerification);
    recordLoad(populated);

    const identityPath = identityPathFor(populated);
    expect(fsSync.existsSync(identityPath)).toBe(false);
    const rebuilt = prepare(fixture);
    if (rebuilt.status === "unavailable") throw new Error(rebuilt.error.message);
    expect(rebuilt.verified).toBe(true);
    expect(rebuilt.sha256).not.toBe(populated.sha256);
  });

  it("ignores a malformed identity record instead of trusting it", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);
    recordLoad(populated);

    const identityPath = identityPathFor(populated);
    await fs.writeFile(identityPath, '{"version":1,"sha256":');
    expect(
      lookupNativeRuntimeCacheEntry({
        sourcePath: fixture.binaryPath,
        packageName: PACKAGE_NAME,
        packageVersion: VERSION,
        target: TARGET,
        cacheRoot: fixture.cacheRoot,
      }),
    ).toBeNull();

    const rebuilt = prepare(fixture);
    if (rebuilt.status === "unavailable") throw new Error(rebuilt.error.message);
    expect(rebuilt.verified).toBe(true);
  });

  it("retains fast identities for every install sharing one cache entry", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);
    recordLoad(populated);

    // Projects can install the same binary under different realpaths yet share its
    // content-addressed cache entry. Each must keep its own origin and warm fast path.
    const sibling = { ...(await makeFixture()), cacheRoot: fixture.cacheRoot };
    const siblingPrepared = prepare(sibling);
    if (siblingPrepared.status === "unavailable") throw new Error(siblingPrepared.error.message);
    recordLoad(siblingPrepared);

    expect(
      lookupNativeRuntimeCacheEntry({
        sourcePath: fixture.binaryPath,
        packageName: PACKAGE_NAME,
        packageVersion: VERSION,
        target: TARGET,
        cacheRoot: fixture.cacheRoot,
      }),
    ).not.toBeNull();
    expect(
      lookupNativeRuntimeCacheEntry({
        sourcePath: sibling.binaryPath,
        packageName: PACKAGE_NAME,
        packageVersion: VERSION,
        target: TARGET,
        cacheRoot: fixture.cacheRoot,
      }),
    ).not.toBeNull();
    expect(prepare(fixture)).toMatchObject({ verified: false });
    expect(prepare(sibling)).toMatchObject({ verified: false });
  });

  it("rejects an identity timestamp from the future", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);
    recordLoad(populated);

    const identityPath = identityPathFor(populated);
    const identity = JSON.parse(await fs.readFile(identityPath, "utf8")) as { verifiedAt: string };
    identity.verifiedAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await fs.writeFile(identityPath, JSON.stringify(identity));

    expect(
      lookupNativeRuntimeCacheEntry({
        sourcePath: fixture.binaryPath,
        packageName: PACKAGE_NAME,
        packageVersion: VERSION,
        target: TARGET,
        cacheRoot: fixture.cacheRoot,
      }),
    ).toBeNull();
    expect(prepare(fixture)).toMatchObject({ verified: true });
  });

  it("declines a record written by a runtime that cannot load it here", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);
    recordLoad(populated);

    const identityPath = identityPathFor(populated);
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
        packageName: PACKAGE_NAME,
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

    // An entry produced before path-keyed identity records: manifest.json and the binary, no
    // matching record. It must still resolve, just without the fast path.
    const entryPath = path.dirname(populated.loadedPath);
    await fs.rm(identityPathFor(populated));
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

  it("leaves a locked entry intact", async () => {
    const shared = await makeFixture();
    const cacheRoot = shared.cacheRoot;

    const abandoned = await fixtureAtVersion("1.9.0", "other-binary-contents", cacheRoot);
    const abandonedEntry = prepareAt(abandoned, "1.9.0");
    if (abandonedEntry.status === "unavailable") throw new Error(abandonedEntry.error.message);
    const abandonedManifest = path.join(path.dirname(abandonedEntry.loadedPath), "manifest.json");

    const originalUnlink = fsSync.unlinkSync;
    const unlink = vi.spyOn(fsSync, "unlinkSync").mockImplementation((filePath) => {
      if (path.resolve(filePath.toString()) === path.resolve(abandonedEntry.loadedPath)) {
        const error = new Error("native cache binary is in use") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      originalUnlink(filePath);
    });
    try {
      const current = await fixtureAtVersion(VERSION, "current-binary-contents", cacheRoot);
      const currentEntry = prepareAt(current, VERSION, Date.now() + RETENTION_MS + 60_000);
      if (currentEntry.status === "unavailable") throw new Error(currentEntry.error.message);
    } finally {
      unlink.mockRestore();
    }

    expect(fsSync.existsSync(abandonedEntry.loadedPath)).toBe(true);
    expect(fsSync.existsSync(abandonedManifest)).toBe(true);
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

    expect(identity).toMatchObject({
      available: true,
      supportedLanguageIds: LANGUAGES,
      origin: originFor(populated),
    });
    expect(identity?.cacheIdentityRevalidateAt).toBeGreaterThan(Date.now());
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

  it("reuses a cached fingerprint only until its identity revalidation deadline", async () => {
    const fixture = await makeFixture();
    const populated = prepare(fixture);
    if (populated.status === "unavailable") throw new Error(populated.error.message);
    recordLoad(populated);
    const cacheEntry = lookupNativeRuntimeCacheEntry({
      sourcePath: fixture.binaryPath,
      packageName: PACKAGE_NAME,
      packageVersion: VERSION,
      target: TARGET,
      cacheRoot: fixture.cacheRoot,
    });
    if (!cacheEntry) throw new Error("expected a recorded cache identity");

    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platformDescriptor) throw new Error("expected process.platform descriptor");
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });

    const workspaceProbe = vi.spyOn(bindingLoader, "findLocalNativeBinary").mockReturnValue(null);
    const platformPackage = vi
      .spyOn(bindingLoader, "readPlatformPackage")
      .mockReturnValue({ sourcePath: fixture.binaryPath, packageVersion: VERSION });
    const target = vi.spyOn(bindingLoader, "currentNativeTargetSuffix").mockReturnValue(TARGET);
    const lookup = vi.spyOn(runtimeCache, "lookupNativeRuntimeCacheEntry").mockReturnValue(cacheEntry);
    const now = Date.now();

    try {
      __resetNativeTreeSitterBindingForTests();
      const first = getNativeRuntimeFingerprint();
      expect(getNativeRuntimeFingerprint()).toBe(first);
      expect(lookup).toHaveBeenCalledTimes(1);

      vi.useFakeTimers();
      const expiredAt = now + 24 * 60 * 60 * 1000 + 1_000;
      vi.setSystemTime(expiredAt);
      expect(Date.now()).toBe(expiredAt);
      getNativeRuntimeFingerprint();
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      __resetNativeTreeSitterBindingForTests();
      lookup.mockRestore();
      target.mockRestore();
      platformPackage.mockRestore();
      workspaceProbe.mockRestore();
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  });
});
