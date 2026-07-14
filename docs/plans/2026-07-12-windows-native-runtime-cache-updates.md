# Windows native runtime cache and update resilience

Date: 2026-07-12
Status: Implemented

## Goal

Allow `npm install -g @lzehrung/codegraph@latest` to replace a global Codegraph installation on Windows even while long-running Codegraph MCP servers are using the native runtime.

The primary design change is to stop loading the Windows `.node` addon from npm-owned package paths. Codegraph will copy the resolved native addon into an immutable, content-addressed per-user cache and load that cached copy instead.

The implementation must also make the running-versus-installed version visible, provide safe update diagnostics, and document the one-time transition requirement for users upgrading from a direct-loading release.

## Why this plan exists

A global update from `@lzehrung/codegraph@1.8.92` to `1.8.93` failed on Windows with:

```text
EBUSY: resource busy or locked, copyfile
C:\Users\...\node_modules\@lzehrung\codegraph\node_modules\
  @lzehrung\codegraph-native-win32-x64-msvc\index.win32-x64-msvc.node
->
C:\Users\...\node_modules\@lzehrung\.codegraph-<retirement-id>\node_modules\
  @lzehrung\codegraph-native-win32-x64-msvc\index.win32-x64-msvc.node
```

Runtime inspection found four global Codegraph stdio MCP server processes. Two had the exact npm-owned `index.win32-x64-msvc.node` mapped. They were children of long-running agent sessions. The other two could load the addon lazily during the update window.

The npm log established that:

- dependency resolution selected the new release successfully;
- failure occurred during `reify:retireShallow`, before extraction or package lifecycle scripts;
- npm first attempted to rename the old global package;
- npm fell back to recursively copying the package to a temporary sibling;
- the copy failed on the native `.node` file;
- a failed retirement directory remained afterward;
- the active install could be left partially damaged by an interrupted retry.

Stopping only the exact Codegraph MCP child processes, preserving the stale retirement directory outside the install scope, and retrying the install completed successfully.

The evidence proves that running MCP processes mapped the npm-owned native addon. It does not isolate whether the active source mapping, the stale retirement destination, or a transient filesystem holder caused the exact `CopyFileW` failure. The design therefore removes Codegraph's persistent handle from npm-owned files and adds diagnostics for stale retirement state.

## Current behavior

The native runtime is lazy but process-lifetime once loaded.

```text
MCP request that needs indexing
  -> resolveNativeBindingState()
  -> loadBinding()
  -> loadNativeBinding()
  -> require("@lzehrung/codegraph-native")
  -> require("@lzehrung/codegraph-native-win32-x64-msvc")
  -> process.dlopen(index.win32-x64-msvc.node)
```

Relevant code:

- `src/native/runtime.ts`
  - caches `NativeBindingState` for the process lifetime;
- `src/native/bindingLoader.ts`
  - prefers a local workspace binary;
  - otherwise loads `@lzehrung/codegraph-native`;
- `packages/codegraph-native/index.js`
  - resolves and eagerly requires the platform package;
- `src/worker/nativeExtractWorker.ts`
  - uses the same binding loader inside native extraction workers;
- `src/mcp/server.ts`
  - keeps stdio servers alive for the client-owned connection;
  - currently advertises hardcoded MCP server version `1.0.0`.

An MCP process does not load the native addon merely because `mcp serve` starts. It loads the addon on warmup or on the first operation that needs native indexing. Once loaded, Node and N-API keep it mapped until the process exits.

## Product decisions

### 1. Load an immutable cached copy on Windows

For installed packages on Windows, resolve the platform-specific `.node` entry without loading it, copy it to a content-addressed cache, verify the copied bytes, and require the cached path.

Do not cache a local source-checkout build. Developers rebuilding `packages/codegraph-native` must continue loading the current workspace binary directly.

### 2. Keep package-manager ownership separate from runtime ownership

npm owns files under its global package root. Long-running Codegraph processes must not map native files from that root.

Codegraph owns files under its per-user native cache. Old processes may keep old cache entries mapped without blocking npm or a new Codegraph version.

### 3. Preserve exact bytes and immutable identities

A cache entry is identified by:

- cache schema version;
- native package name;
- native package version;
- platform target suffix;
- SHA-256 of the native binary.

A final cache entry is never overwritten in place.

### 4. Do not auto-kill hosts or arbitrary Node processes

Codegraph must not terminate OMP, Codex, Cursor, other IDEs, or every `node.exe` process. Agent clients own stdio MCP lifecycles and may have unsaved state.

Diagnostics may identify exact Codegraph child processes. Any stop operation must remain explicit and separately authorized.

### 5. Do not build a detached self-updater

A detached updater races with clients that respawn stdio MCP servers. It can wait indefinitely, lose errors, or collide with a newly loaded runtime.

A future `codegraph upgrade` may check readiness, print or invoke the correct package-manager command with explicit consent, and verify the result. It must not replace npm as the install authority for npm-managed installs.

### 6. Keep restart visibility even after lock prevention

The cache allows npm to update successfully while an old MCP server remains alive. That process still runs the old Codegraph version until the client reconnects.

Codegraph must expose the running version and native cache identity, detect installed-version drift, and tell the user which sessions need restart. Automatic termination is deferred until every supported client has proven reconnect behavior.

## Scope

### In scope

- Windows content-addressed native addon cache;
- installed-package native resolution without eager loading;
- race-safe atomic cache population;
- cache integrity verification;
- cache-origin metadata in native runtime state;
- doctor diagnostics for native source, loaded path, cache identity, and stale npm retirement paths;
- actual Codegraph package version in MCP server information;
- installed-versus-running version drift detection;
- Windows update and restart documentation;
- bounded, non-destructive stale-cache cleanup guidance;
- deterministic tests for success, races, corruption, fallback, and non-Windows compatibility;
- a Windows integration test proving a process loads the cached DLL rather than the npm-owned source.

### Out of scope

- silently killing agent or IDE processes;
- broad process termination by executable name;
- replacing npm for npm-managed installs;
- mandatory background daemon management;
- automatic self-update during MCP requests;
- full immutable JavaScript runtime copies in the first implementation;
- changing native parser semantics or supported languages;
- changing local source-checkout native build behavior;
- deleting locked cache entries;
- treating a cache failure as proof that native support is unavailable.

## Target architecture

```text
Global npm package
  @lzehrung/codegraph
    node_modules/
      @lzehrung/codegraph-native-win32-x64-msvc/
        index.win32-x64-msvc.node
              |
              | resolve, realpath, stream-hash, copy, verify
              v
Per-user immutable runtime cache
  %LOCALAPPDATA%\codegraph\native-cache\v1\
    win32-x64-msvc\
      1.8.72-<sha256>\
        index.win32-x64-msvc.node
        manifest.json
              |
              | require(cached path)
              v
Long-running MCP process
```

After this change, a running MCP process maps only the cached binary. npm may rename, copy, remove, or replace its own package directory without Codegraph holding that native source file open.

## Cache layout and manifest

Default root on Windows:

```text
%LOCALAPPDATA%\codegraph\native-cache\v1
```

Entry layout:

```text
v1\
  win32-x64-msvc\
    1.8.72-0123456789abcdef...\
      index.win32-x64-msvc.node
      manifest.json
```

Manifest schema:

```ts
type NativeCacheManifestV1 = {
  schemaVersion: 1;
  packageName: string;
  packageVersion: string;
  target: string;
  sourceFileName: string;
  sourceSize: number;
  sourceSha256: string;
  cachedAt: string;
};
```

The manifest is diagnostic metadata, not the integrity authority. Codegraph must hash the cached binary before loading it. A matching manifest without matching bytes is invalid.

Do not add a public environment variable for the cache root in the first implementation. Tests may inject an internal cache root through loader dependencies. Production uses `%LOCALAPPDATA%` on Windows and falls back to direct package loading with a diagnostic when no safe per-user cache root is available.

## Native binding location contract

Extend the loader result so callers and doctor output can report what was loaded.

```ts
type NativeBindingOrigin = {
  mode: "workspace" | "package" | "cache";
  packageName: string;
  packageVersion?: string;
  target?: string;
  sourcePath?: string;
  loadedPath?: string;
  cacheKey?: string;
  sha256?: string;
  cacheError?: string;
};

type NativeBindingLoadResult<T> =
  | {
      binding: T;
      error?: undefined;
      origin: NativeBindingOrigin;
    }
  | {
      binding: null;
      error?: unknown;
      origin?: NativeBindingOrigin;
    };
```

Extend the loaded branch of `NativeBindingState`:

```ts
type NativeBindingState =
  | {
      loaded: true;
      binding: NativeBinding;
      supportedLanguageIds: Set<string>;
      origin: NativeBindingOrigin;
    }
  | {
      loaded: false;
      error?: unknown;
      origin?: NativeBindingOrigin;
    };
```

All paths returned publicly must use the repository's normalized display form. Internal filesystem calls retain native absolute paths.

## Installed native package resolution

The current fallback requires the umbrella package, which immediately loads the platform addon. The cache must resolve the platform binary before any `require()` or `dlopen` occurs.

For `packageName = "@lzehrung/codegraph-native"` and target `win32-x64-msvc`:

```text
platformPackageName = "@lzehrung/codegraph-native-win32-x64-msvc"
platformEntry = require.resolve(platformPackageName)
```

Validate that:

- resolution succeeds;
- the entry basename is exactly `index.win32-x64-msvc.node`;
- the resolved path exists and is a regular file;
- `realpath` succeeds;
- the adjacent platform package metadata names the expected package;
- the platform package version is present;
- the binary size is positive.

Package-manager layouts may use symlinks or junctions. Resolve the source to its real path rather than rejecting valid npm/pnpm layouts solely because an ancestor is linked. Cache destination paths require stricter reparse-point checks.

If direct platform resolution fails, retain the current umbrella-package fallback and record a cache-origin diagnostic. Do not convert an optional native package resolution failure into an unconditional CLI startup failure when runtime mode is `auto`.

## Hashing without avoidable allocation

The Windows x64 binary is roughly 30 MB. Do not use `readFileSync()` and allocate the entire binary only to compute a hash.

Use a fixed-size reusable buffer with `openSync`, `readSync`, and `createHash("sha256")`:

```text
open source
allocate one bounded buffer
read chunk
hash.update(chunk view)
repeat
close in finally
```

A 1 MiB buffer is sufficient. The hash helper returns SHA-256 and total bytes read. Reject a size mismatch against the pre-hash stat to catch replacement during hashing.

## Secure cache-root preparation

Before writing:

1. Resolve `%LOCALAPPDATA%`.
2. Construct the fixed `codegraph/native-cache/v1` child path.
3. Create missing directories one component at a time.
4. For every existing cache component, use `lstat` and reject symbolic links or reparse-point-like substitutions supported by Node's APIs.
5. Resolve the real cache root.
6. Confirm all candidate paths remain inside that real root.
7. Never accept a caller-provided production path from MCP/CLI input.

If safe cache preparation fails, return a diagnostic and use the direct package fallback. Never load an unverified file from an unsafe cache root.

## Atomic cache population

For the expected final binary path:

```text
<entry>\index.win32-x64-msvc.node
```

use this algorithm:

1. If the final file exists:
   - require a regular file;
   - stream-hash it;
   - use it only if size and SHA-256 match the source.
2. If it is missing:
   - copy the source to a unique sibling temporary file;
   - use exclusive creation;
   - close the temporary file before verification;
   - stream-hash the temporary file;
   - reject and remove it if size or hash differs;
   - rename it atomically to the final immutable name.
3. If another process wins the final rename race:
   - remove this process's temporary file;
   - verify the winner's final file;
   - use the winner only when its bytes match.
4. Write `manifest.json` through the same temporary-file and atomic-rename pattern.
5. Require the final cached `.node` path.

Never overwrite the final cached binary. A mapped cache file is immutable for its entire lifetime.

Temporary file names must include PID and random entropy:

```text
index.win32-x64-msvc.node.<pid>.<random>.tmp
```

A failed startup may leave temporary files. Doctor cleanup may remove old `.tmp` files that are regular files, remain within the cache root, and exceed a conservative age threshold.

## Corrupt cache handling

If the final file exists but has the wrong hash:

1. Do not require it.
2. Attempt to rename it within the same entry to a bounded recovery name.
3. Populate a correct immutable final file.
4. If rename or repair fails, fall back to direct package loading and report `cacheError`.

Never overwrite or delete a file that may be mapped. Never treat a manifest match as sufficient when the binary hash differs.

## Fallback behavior

The loader must preserve current availability behavior.

```text
workspace binary exists
  -> load workspace binary directly

installed Windows platform binary resolves
  -> prepare and verify cache
  -> load cached binary

cache preparation fails
  -> record cacheError
  -> load installed umbrella package directly

installed native package fails
  -> preserve current unavailable/reduced-mode behavior
```

When runtime mode is `on`, existing required-native failure behavior remains authoritative. When runtime mode is `auto`, cache failure alone does not disable native parsing if direct loading still succeeds.

## Worker behavior

`src/worker/nativeExtractWorker.ts` calls the same `loadNativeBinding()` helper. It must therefore resolve the same cache key and cached path as the main process.

Required invariant:

```text
main process loadedPath == worker loadedPath
```

Concurrent main-thread and worker initialization must be safe through the atomic population algorithm. No separate worker cache implementation is allowed.

## Runtime and doctor diagnostics

Extend `DoctorReport.native`:

```ts
type DoctorNativeReport = {
  available: boolean;
  loadError?: string;
  supportedLanguageIds: string[];
  origin?: {
    mode: "workspace" | "package" | "cache";
    packageName: string;
    packageVersion?: string;
    target?: string;
    sourcePath?: string;
    loadedPath?: string;
    cacheKey?: string;
    sha256?: string;
    updateSafeForCurrentProcess: boolean;
    cacheError?: string;
  };
  update?: {
    staleRetirementPaths: string[];
    restartRequired: boolean;
    runningVersion?: string;
    installedVersion?: string;
    reason?: string;
  };
};
```

`updateSafeForCurrentProcess` means only that this process did not map an npm-owned native binary. It must not claim that no other process on the machine holds the source file.

Cross-process PID attribution through Windows Restart Manager is useful but not required for the first cache PR. Do not scrape or kill arbitrary processes merely to produce doctor output. A later diagnostic may use Restart Manager or a narrowly scoped platform helper after a separate security review.

Detect stale npm retirement siblings conservatively:

- only direct children of the resolved package scope directory;
- only names matching npm's `.codegraph-*` retirement form;
- report paths but do not delete them during normal doctor execution;
- offer a separate explicit cleanup action only after path, ownership, and liveness checks.

## MCP running-version identity

Replace the hardcoded MCP server version in `src/mcp/server.ts`:

```ts
{
  name: "codegraph",
  version: getCodegraphVersion(),
}
```

Capture runtime identity once when the server starts:

```ts
type CodegraphRuntimeIdentity = {
  startedAt: string;
  runningVersion: string;
  packageRoot: string;
  nativeOrigin?: NativeBindingOrigin;
};
```

Do not recompute `runningVersion` from package metadata after an update. It identifies the code already loaded into the process.

## Installed-version drift

A cached native addon removes npm's DLL lock, but an old MCP process can remain alive after npm installs a new version.

Add a throttled installed-version check:

- read no more than once every 30 seconds;
- read the package metadata path captured at startup;
- compare the current disk version with `runningVersion`;
- tolerate temporary absence or malformed JSON during package replacement;
- warn once per observed installed version;
- never crash an in-flight request;
- do not automatically exit in the first implementation.

The status should distinguish:

```text
same version
  -> restartRequired: false

new version on disk
  -> restartRequired: true
  -> reason: "installed Codegraph 1.8.94 differs from running MCP 1.8.93"

package path temporarily unavailable
  -> restartRequired: true
  -> reason: "Codegraph installation changed while this MCP server was running"
```

Expose drift through doctor and existing server logs first. If a stable MCP status tool is added, update `docs/mcp.md`, `docs/cli.md`, the bundled skill, and protocol tests in the same change.

## Update workflow

This plan complements `docs/plans/2026-07-03-13-upgrade-command.md`.

For npm-managed installs, a future `codegraph upgrade` should:

1. report current, latest, and running MCP versions;
2. report whether the current process loaded from cache or the package path;
3. report stale npm retirement siblings;
4. print the exact scoped-registry package-manager command;
5. require explicit consent before `--apply` is ever added;
6. execute npm as the install authority;
7. verify the installed version afterward;
8. tell the user which clients still run the old version.

The command must not kill host applications or silently rewrite MCP configuration.

A package `preinstall`, `install`, or `postinstall` script cannot solve the raw npm update failure. npm retires the old package before incoming lifecycle scripts run. Do not add lifecycle scripts that claim to preflight this condition.

## Transition behavior

The first release containing this cache still has a bootstrap problem: older running MCP servers load the DLL directly from the npm package.

Users must perform one final stop-update-restart sequence to install the cache-enabled release:

1. close or disconnect Codegraph MCP clients;
2. confirm no Codegraph native DLL is mapped;
3. install the cache-enabled release;
4. restart clients.

After all running clients use the cache-enabled loader, later npm updates should no longer be blocked by Codegraph mapping the npm-owned native file.

Release notes and installation docs must state this one-time transition explicitly.

## Implementation phases

### Phase 1: cache primitives

Add a focused internal module, for example:

```text
src/native/runtimeCache.ts
```

Responsibilities:

- fixed production cache-root resolution;
- source and cached file streaming hashes;
- safe cache-root preparation;
- cache-key construction;
- immutable entry verification;
- atomic race-safe population;
- manifest creation;
- bounded corruption recovery;
- structured result without loading the addon.

Suggested contract:

```ts
type PrepareNativeRuntimeCacheRequest = {
  sourcePath: string;
  packageName: string;
  packageVersion: string;
  target: string;
  cacheRoot?: string; // Internal test dependency only.
};

type PrepareNativeRuntimeCacheResult =
  | {
      status: "cached" | "reused";
      sourcePath: string;
      loadedPath: string;
      cacheKey: string;
      sha256: string;
    }
  | {
      status: "unavailable";
      sourcePath: string;
      error: Error;
    };
```

The module does not call `require()` and does not know about `NativeBinding`.

### Phase 2: binding-loader integration

Update `src/native/bindingLoader.ts`:

- preserve workspace binary precedence;
- derive the platform package name;
- resolve the platform entry without loading it;
- read validated platform package metadata;
- call the Windows cache module;
- require the returned cached path;
- fall back to the current umbrella package path on cache failure;
- return structured origin metadata.

Update both:

- `src/native/runtime.ts`;
- `src/worker/nativeExtractWorker.ts`.

Do not implement a second cache path in `packages/codegraph-native/index.js` in this phase. Codegraph's loader must intercept before the umbrella package eagerly loads the platform addon. If the native wrapper later becomes a public standalone runtime, move or share the cache implementation in a separate compatibility change.

### Phase 3: diagnostics and identity

Update:

- `src/native/contracts.ts`;
- `src/cli/doctor.ts`;
- `src/cli/packageInfo.ts` as needed;
- `src/mcp/server.ts`;
- CLI JSON/pretty doctor formatting;
- MCP server version metadata.

Keep diagnostics bounded and avoid cross-process enumeration in the initial implementation.

### Phase 4: drift warning

Add the throttled installed-version comparison and one-time warning. It must not fail tool calls or terminate the server.

If future client testing proves graceful reconnect behavior, a separate change may add an opt-in server exit after an update.

### Phase 5: cleanup and documentation

Only after cache loading and diagnostics work end to end:

- document Windows update behavior;
- document the one-time transition;
- document cache layout and cleanup;
- update CLI/MCP contracts;
- update the bundled skill;
- add release guidance;
- remove any temporary test-only scaffolding.

## TDD implementation sequence

Follow vertical RED-GREEN slices. Do not write all tests before implementation.

### Slice 1: installed Windows binding loads from cache

RED:

- resolve a synthetic installed Windows platform package;
- call the public binding loader with injected resolver/require boundary;
- assert `requireFn` receives a cache path outside the package root;
- assert bytes match the source.

GREEN:

- implement minimum cache root, hash, copy, verify, and load path.

### Slice 2: same bytes reuse one immutable entry

RED:

- load the same package twice;
- assert the same cache path is used;
- assert the final binary is not rewritten.

GREEN:

- verify and reuse an existing content-addressed entry.

### Slice 3: concurrent population is race-safe

RED:

- launch multiple child processes or isolated workers against one empty cache;
- assert every process receives the same verified final path;
- assert no partial final binary is observed.

GREEN:

- add exclusive temporary files, atomic rename, and winner verification.

### Slice 4: corrupt cache is never loaded

RED:

- place wrong bytes at the expected final path;
- assert `requireFn` never receives those bytes/path;
- assert repair or safe fallback is reported.

GREEN:

- add hash verification and bounded repair.

### Slice 5: unsafe or unavailable cache falls back

RED:

- simulate missing `%LOCALAPPDATA%`, permission failure, and unsafe cache path;
- assert direct package loading remains available;
- assert structured `cacheError` is retained.

GREEN:

- add safe fallback without changing native-required semantics.

### Slice 6: non-Windows behavior remains unchanged

RED/GREEN contract:

- Linux and macOS installed-package calls continue requiring the umbrella package;
- local workspace binaries continue loading directly on all platforms;
- no cache directory is created outside Windows installed-package mode.

### Slice 7: main and worker paths agree

RED:

- load through runtime and native worker boundaries;
- assert both report the same cache identity and loaded path.

GREEN:

- route both through the shared loader/cache module.

### Slice 8: doctor reports origin and update readiness

RED:

- assert JSON doctor output distinguishes workspace, package, and cache origins;
- assert cache error and stale retirement paths are bounded and normalized.

GREEN:

- extend doctor report and formatting.

### Slice 9: MCP advertises actual running version

RED:

- initialize the MCP protocol server;
- assert server info uses the package version rather than hardcoded `1.0.0`.

GREEN:

- inject captured package identity into protocol server creation.

### Slice 10: installed-version drift is non-fatal

RED:

- start with version A;
- change readable package metadata to version B;
- assert restart-required status/warning;
- assert tool calls still complete;
- assert repeated checks are throttled and warnings deduplicated.

GREEN:

- add runtime identity and throttled comparison.

## Test matrix

### Focused unit and behavior suites

Update or add coverage near:

- `tests/native-binding-loader.test.ts`;
- `tests/native-runtime-mode.test.ts`;
- `tests/native-worker-path.test.ts`;
- `tests/cli-command-modules.test.ts`;
- `tests/cli-regressions.test.ts`;
- `tests/mcp-server.test.ts`.

Required cases:

- Windows x64 and arm64 package-name derivation;
- workspace binary bypasses cache;
- installed Windows binary uses cache;
- installed non-Windows binary keeps current behavior;
- cache key changes when package version or bytes change;
- identical bytes reuse the same entry;
- source replacement during hash is rejected;
- concurrent writers converge;
- partial temporary files are ignored;
- corrupt final bytes are never loaded;
- symlink/reparse cache destination is rejected;
- permission failure falls back with diagnostic;
- native `on` and `auto` semantics remain correct;
- main and worker loaded paths match;
- doctor output is deterministic and bounded;
- MCP server version is current;
- drift warning is throttled and non-fatal.

### Windows integration test

Add a Windows-only native-required integration test that uses a real built/published native binary:

1. create a temporary installed-package-like tree;
2. launch a child process that loads native through Codegraph's binding loader;
3. trigger a native operation;
4. have the child report `sourcePath`, `loadedPath`, version, and hash;
5. assert `loadedPath` is under the cache root and not under the package tree;
6. while the child remains alive, rename or remove the synthetic package source tree;
7. assert the operation succeeds;
8. assert the child can complete another already-loaded native call;
9. stop the child cleanly;
10. clean the synthetic cache entry.

Do not run this test against the developer's real global npm root. Do not stop unrelated processes.

### Regression for the reported failure class

The acceptance regression is not a source-text assertion. It must prove the observable invariant:

```text
A live Codegraph process using native parsing does not map the native addon from the npm-owned package path.
```

On Windows CI, inspect the child process module list or use loader-reported origin plus a successful rename of the synthetic source package while the child remains alive.

## Documentation updates

Update in the same implementation change:

- `README.md`
  - concise Windows updating note and link to installation docs;
- `docs/installation.md`
  - updating section;
  - one-time transition requirement;
  - safe stop/retry/restart procedure for older releases;
  - native cache location and cleanup behavior;
- `docs/mcp.md`
  - running-version identity;
  - restart-required behavior;
  - cached native runtime lifecycle;
- `docs/cli.md`
  - doctor JSON/pretty output changes;
  - any new diagnostic flags;
- `docs/how-it-works.md`
  - package-owned source versus cached loaded binary;
- `codegraph-skill/codegraph/SKILL.md`
  - update troubleshooting and any doctor/upgrade surface changes;
- `PUBLISHING.md`
  - release validation for Windows cache-enabled packages;
- `docs/plans/2026-07-03-13-upgrade-command.md`
  - cross-reference this runtime-cache prerequisite;
- `docs/plans/2026-07-03-03-shared-server-lifecycle.md`
  - clarify that shared servers also load immutable cache entries and report runtime identity.

Do not change `docs/language-parity.md` unless native availability claims change. This plan changes loading and lifecycle, not language semantics.

## Release and rollout

### Cache-enabled release validation

Before publishing:

- package all Windows target artifacts;
- verify platform package resolution for x64 and arm64;
- run native-required Windows tests;
- run the synthetic live-process source-replacement integration test;
- inspect published tarball contents;
- verify doctor reports cache origin from an installed package;
- verify reduced mode still works when native packages are absent;
- verify a global update succeeds while a cache-enabled MCP process remains alive;
- verify the old MCP process reports restart required after the update;
- verify a new MCP process reports the new version and cache key.

### Transition release note

State explicitly:

```text
Windows users must close existing Codegraph MCP clients once before installing this release. Older Codegraph processes load the native addon directly from npm's package directory. After this cache-enabled release is installed and clients are restarted, later global updates no longer require stopping Codegraph solely to release the npm-owned native DLL.
```

Do not claim updates are universally lock-free. Antivirus, backup software, stale npm retirement paths, and other filesystem holders may still produce `EBUSY`. The exact product claim is that Codegraph no longer keeps the npm-owned native addon mapped.

## Failure and rollback strategy

- Cache failure falls back to the current direct package loader.
- Native `auto` may still degrade if both cache and direct load fail.
- Native `on` retains explicit failure behavior.
- Removing cache integration restores current loading without changing cache data.
- Old cache entries are inert files and may be removed after no process maps them.
- Cache schema changes use a new top-level schema directory (`v2`, not in-place mutation).
- Do not migrate or rewrite mapped `v1` entries.

## Primary evidence and references

- Microsoft `DeleteFileW` mapped-file behavior: <https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew>
- Microsoft dynamic-link library update guidance: <https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-updates>
- Node.js 24.15 native binding lifecycle: <https://github.com/nodejs/node/blob/v24.15.0/src/node_binding.cc#L379-L399>
- npm filesystem move fallback used during package retirement: <https://github.com/npm/fs/blob/v5.0.0/lib/move-file.js#L27-L67>
- Existing upgrade command plan: [`2026-07-03-13-upgrade-command.md`](./2026-07-03-13-upgrade-command.md)
- Existing shared server lifecycle plan: [`2026-07-03-03-shared-server-lifecycle.md`](./2026-07-03-03-shared-server-lifecycle.md)

The incident establishes that Codegraph processes mapped the npm-owned binary and that the update succeeded after those processes stopped and the stale retirement directory moved aside. It does not claim that a mapped source DLL was the only possible `CopyFileW` holder. Tests and release language must preserve that distinction.

## Rejected alternatives

### Stop MCP servers automatically

Rejected because hosts own stdio children, may respawn them immediately, and may contain unsaved user state.

### Kill all Node processes

Rejected as unsafe and unrelated to Codegraph ownership.

### Incoming npm lifecycle preflight

Rejected because npm retires the old package before incoming lifecycle scripts execute.

### Detached updater

Rejected because it races with host respawn and duplicates package-manager responsibility.

### One mutable cache filename

Rejected because the next update recreates the same mapped-file conflict.

### Cache under `%TEMP%`

Rejected because shared or weakly controlled temporary locations increase DLL planting and cleanup risk.

### Copy the complete runtime immediately

Deferred. A full immutable runtime would also eliminate mixed-version lazy import risk, but requires a self-contained bundled MCP artifact and materially more lifecycle machinery. Implement the native cache and drift visibility first.

### Load with native mode disabled during updates

Insufficient. Existing servers may already have loaded the addon, and raw npm updates cannot reconfigure them before package retirement.

## Relationship to a future immutable runtime

If zero-restart or long-lived mixed-version operation becomes a product requirement, evolve from native-only cache to:

```text
%LOCALAPPDATA%\codegraph\runtimes\
  <codegraph-version>-<artifact-hash>\
    dist\
    native\
    runtime-manifest.json
```

A stable launcher would start MCP from one immutable runtime. Existing sessions finish on the old runtime, new sessions use the new runtime, and npm replaces only the launcher/package metadata.

This is not required to fix the current native DLL lock. Keep it as a separately reviewed follow-up after the native cache has production evidence.

## Acceptance criteria

The plan is complete only when all of the following are true:

- Installed Windows Codegraph resolves the platform `.node` entry without loading it from the package path.
- The native binary is copied to a per-user, content-addressed, immutable cache.
- The cached bytes are SHA-256 verified before loading.
- Cache population is safe across concurrent MCP processes.
- No final cached binary is overwritten in place.
- Workspace source-checkout binaries keep current direct-load behavior.
- Non-Windows installed-package behavior remains compatible.
- Main and worker native loading use the same cache implementation and cache key.
- Native runtime state records source and loaded origins.
- Doctor reports the cache origin, fallback errors, and restart/version drift honestly.
- MCP server info advertises the actual running Codegraph version.
- Installed-version drift does not crash or silently terminate tool calls.
- A Windows integration test proves a live native process does not map the npm-owned source binary.
- A synthetic package source can be renamed while the cache-loaded process remains alive.
- The first cache-enabled release documents the one-time stop-update-restart transition.
- CLI/MCP output changes are documented in `docs/cli.md`, `docs/mcp.md`, and the bundled skill.
- Published Windows x64 and arm64 package layouts are validated.
- Focused native, worker, CLI doctor, and MCP tests pass.
- `npm run test:native`, `npm run test:integration`, and `npm run check` pass in the intended CI environments.
- No automatic host termination, detached updater, unsafe temp loading, or unbounded cache cleanup is introduced.

## Suggested implementation ownership

One agent should own cache primitives and binding-loader integration because their contracts are tightly coupled. A second independent agent may own doctor/MCP identity after the loader result shape is fixed. A third agent may own documentation and Windows integration coverage after behavior is working.

Do not parallelize edits to `src/native/bindingLoader.ts`, `src/native/runtime.ts`, and `src/native/contracts.ts` across multiple agents. Establish the loader and origin contract first, then fan out diagnostics and documentation.

## Verification commands

During vertical implementation, use the narrowest relevant suites:

```bash
npx vitest run tests/native-binding-loader.test.ts
npx vitest run tests/native-runtime-mode.test.ts tests/native-worker-path.test.ts
npx vitest run tests/cli-command-modules.test.ts -t "doctor"
npx vitest run tests/cli-regressions.test.ts -t "doctor"
npx vitest run tests/mcp-server.test.ts
```

When the loader and Windows integration are complete:

```bash
npm run test:native
npm run test:integration
```

Before concluding the implementation:

```bash
npm run check
```

## Implementer handoff

Start with `src/native/bindingLoader.ts`, `src/native/runtime.ts`, `src/worker/nativeExtractWorker.ts`, `src/native/contracts.ts`, and `tests/native-binding-loader.test.ts`.

The first proof must be RED-GREEN behavior showing that an installed Windows platform binary is required from a cache path outside the synthetic npm package root. Do not begin with doctor output, docs, cleanup, process detection, or an upgrade command. Those depend on a trustworthy loader-origin contract.

The core invariant is:

```text
Long-running Codegraph processes may map Codegraph-owned immutable cache files, but must not map npm-owned native addon files.
```
