# Installation

Requirements and install paths for local source checkouts, published packages, release tarballs, and runtime selection.

## Requirements

- Node.js 22.16+
- Published installs do not require Rust or a manual native setup step on supported targets.
- Local source checkouts do not require Rust just to build `dist/`, but the native workspace addon only builds when Cargo is available.
- If no compatible native artifact is available, Codegraph drops to reduced graph-only and regex recovery mode instead of loading JS grammars.

## Option 1: Local source checkout

Use this path when you are developing on Codegraph itself or want the least ambiguous first run.

```bash
git clone https://github.com/lzehrung/codegraph.git
cd codegraph
npm install
npm run build
```

`npm run build` always rebuilds `dist/`. If Cargo is available, it also requires the local native workspace build to succeed. If Cargo is unavailable, it still completes with the JavaScript build output and a warning.

Use `npm run build:native` when you specifically want to rebuild the native addon and fail fast if Rust is not installed.

To install the current source checkout globally for local testing, build first, then install from the checkout:

```bash
npm run build
npm install -g .
```

The `prepare` script reuses an existing `dist/` build during global installs because npm does not allow workspace builds in global package lifecycle scripts. If `dist/cli.js` or the published bin entry `dist/bin/cli.js` is missing, run `npm run build` before `npm install -g .`.

The `codegraph` bin points at the split ESM bundle under `dist/bin/`. Unbundled `dist/` modules remain available for tests and library imports.

## Local caches

The published bin stores Node's module compile cache outside the project root: `%LOCALAPPDATA%\codegraph\compile-cache` on Windows, or `$XDG_CACHE_HOME/codegraph/compile-cache` (falling back to `~/.cache/codegraph/compile-cache`) elsewhere. You can remove it at any time; the next startup may be slower, but command output is unchanged.

With disk caching enabled, Codegraph creates `.codegraph-cache/index-v1/search-v1.sqlite` in each project. It contains normalized source and chunk text, so treat it as sensitive derived source data. Cache-off runs create no sidecar.

To remove it safely, stop Codegraph processes and delete `.codegraph-cache`. `uninit` leaves caches alone. [How it works](./how-it-works.md#cache-and-session-behavior) explains the cache mechanics.

## Option 2: Install from the `@lzehrung` registry

Configure the scoped registry if you have not already:

```bash
npm config set "@lzehrung:registry" "https://npm.pkg.github.com"
```

Install the main package:

```bash
npm install @lzehrung/codegraph
```

The published path is native-first: `@lzehrung/codegraph` optionally resolves the matching native artifact automatically when a published binary exists for the current platform. Unsupported hosts use reduced graph-only mode. No separate grammar package is required.

## Option 3: Install from a release tarball

Download and install the root package tarball directly from a GitHub release:

```bash
npm install https://github.com/lzehrung/codegraph/releases/download/vVERSION/lzehrung-codegraph-VERSION.tgz
```

Replace `VERSION` with the desired release version from the GitHub release page.

Each release attaches a pre-built `.tgz` that `npm install` can consume by URL with no registry configuration needed for the root package itself.

Important: the tarball alone does not bundle the native addon. To analyze source languages after a tarball install, configure the `@lzehrung` registry so the optional `@lzehrung/codegraph-native` package can resolve for your platform.

Without the native runtime package, the CLI and library still install, but supported source languages run in reduced graph-only and regex recovery mode.

## Updating on Windows

Installed Windows releases copy the resolved native addon to `%LOCALAPPDATA%\codegraph\native-cache\v1` and load the verified cached copy. Cache entries are content-addressed and immutable, so an existing MCP process can keep using its old entry while npm replaces package-owned files.

The first upgrade from a release that loaded the addon directly requires one transition:

1. Close or disconnect Codegraph MCP clients.
2. Run `npm install -g @lzehrung/codegraph@latest`.
3. Restart the clients and run `codegraph doctor`.

Later upgrades should not be blocked solely because Codegraph mapped npm's native addon. Antivirus, backup software, or stale npm retirement directories can still cause `EBUSY`; `codegraph doctor` reports matching `.codegraph-*` siblings without deleting them.

An MCP server that survives an update continues running its captured version and warns when the installed version differs. Restart that client or shared server to use the new JavaScript runtime and native cache identity.

Old cache entries are inert after every process using them has stopped. Cleanup must be explicit: close Codegraph clients first, then remove only obsolete version/hash directories under the fixed `v1` cache root; never overwrite or delete a mapped entry in place.

## Native runtime modes

The runtime defaults to `native: "auto"`.

- `auto`: use the native Tree-sitter path when a compatible artifact is available and degrade to reduced graph-only mode otherwise
- `on`: require native explicitly and fail if it is unavailable
- `off`: disable native explicitly and run the same reduced graph-only mode

You can set `CODEGRAPH_DISABLE_NATIVE=1` to make `auto` behave like reduced mode by default.

Explicit CLI, library, and tool `native` options take precedence over `CODEGRAPH_DISABLE_NATIVE`.

## Runtime package roles

- `@lzehrung/codegraph`: main library and CLI
- `@lzehrung/codegraph-native`: optional native runtime package that resolves the matching binary artifact

Reduced mode preserves graph-only and regex-backed recovery where available; it does not provide a non-native Tree-sitter parser.

## Certification evidence

A certification report distinguishes the bytes it inspected from the host behavior it executed. `runtime` means the packed root and matching native packages loaded and completed their smoke on that target; `emulated`, `structural`, and `unsupported` remain separate states, and a structural archive check is not a runtime claim.

Semantic reports make the same distinction with `packageMode`. `packed` means the corpus runner loaded the installed candidate package, while `checkout` identifies a source-build trend run; native and reduced results are never combined.

The initial [semantic corpus](./benchmarks/README.md#semantic-correctness-corpus) is informational and does not create an absolute accuracy threshold. Consult the release's machine-readable report before treating a package version or target as certified.

## Agent client setup

After installing the CLI, `codegraph install` can configure Codegraph-owned MCP entries, bundled skill payloads, and marker files for supported agent clients:

```bash
codegraph install --target codex,claude --dry-run
codegraph install --target codex,claude --yes
codegraph install --print-config codex
```

Supported targets are `codex`, `claude`, `cursor`, `gemini`, `opencode`, and `agents`. Writes require `--yes`; `--dry-run` reports the files that would change, and `uninstall` removes only Codegraph-owned marker blocks, marker files, exact bundled skill payloads, or exact installer-owned MCP entries.
The lower-level `codegraph skill install --agent <name>` command remains available when you only want to copy the bundled skill.

## Next steps

- For CLI commands and examples, see [docs/cli.md](./cli.md).
- For library usage, see [docs/library-api.md](./library-api.md).
- For agent sessions, tool wrappers, and review flows, see [docs/agent-workflows.md](./agent-workflows.md).
