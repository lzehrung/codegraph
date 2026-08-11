# Installation

Library-only TypeScript consumers can install `@lzehrung/codegraph-core` to avoid MCP SDK, installer, skill, and graph-viewer package weight. The product package `@lzehrung/codegraph` remains the CLI/MCP distribution and depends on core.

Requirements, standalone and package channels, source checkouts, verification, rollback, caches, and runtime selection.

## Requirements

- Package and source installs require Node.js 22.16+.
- Standalone archives bundle Node.js, production dependencies, the matching native runtime, and the codegraph skill.
- Published installs do not require Rust or a manual native setup step on supported targets.
- Local source checkouts do not require Rust just to build `dist/`, but the native workspace addon only builds when Cargo is available.
- If no compatible native artifact is available, package installs drop to reduced graph-only and regex recovery mode instead of loading JS grammars.

## Option 1: Standalone release (preview)

The standalone channel does not require npm, a system Node.js installation, or registry configuration. It currently identifies itself as `standalone-preview`.
Standalone assets are attached after package publication by a separate release workflow. Use a release that lists the matching archive, installer, and `SHA256SUMS` assets.

PowerShell:

```powershell
irm https://github.com/lzehrung/codegraph/releases/latest/download/install.ps1 | iex
```

POSIX shell:

```bash
curl -fsSL https://github.com/lzehrung/codegraph/releases/latest/download/install.sh | sh
```

Supported target ids are `win32-x64`, `win32-arm64`, `darwin-x64`, `darwin-arm64`, `linux-x64`, and `linux-arm64`. Windows assets are `.zip`; macOS and glibc-based Linux assets are `.tar.gz`. The POSIX bootstrap rejects musl Linux hosts; use the package or source path there. `win32-arm64` currently has structural certification only, not a runtime-host certification claim.

The bootstrap downloads `codegraph-<target>.<archive>` and `SHA256SUMS` from the selected HTTPS release, verifies SHA-256 before extraction, rejects unsafe archive paths and entry types, then runs the bundled `version` and `doctor`. Checksums establish integrity only after the GitHub release download is trusted; the preview channel is not described as signed.
Before downloading or writing, the bootstrap previews the target, version selector, install root, and launcher path, then defaults to no. Noninteractive runs require `-Yes` on PowerShell or `--yes` on POSIX.

To inspect a script before running it:

```powershell
Invoke-WebRequest https://github.com/lzehrung/codegraph/releases/latest/download/install.ps1 -OutFile ./install.ps1 -UseBasicParsing
Get-Content ./install.ps1
./install.ps1 -Latest
```

```bash
curl -fsSL https://github.com/lzehrung/codegraph/releases/latest/download/install.sh -o ./install.sh
cat ./install.sh
sh ./install.sh --latest
```

For reviewed noninteractive automation, use `./install.ps1 -Latest -Yes` or `sh ./install.sh --latest --yes`.

Pin or roll back by running the same script with an explicit release version:

```powershell
./install.ps1 -Version VERSION
```

```bash
sh ./install.sh --version VERSION
```

The installer keeps immutable version roots and reuses an existing root only when the incoming and installed manifests match exactly on target, native suffix, source revision, Node version, and every file path, size, and SHA-256 record. It atomically repoints the user launcher and records `currentVersion`, `previousVersion`, target, release URL, archive hash, and verification method in `install-manifest.json`; a failed launcher or manifest switch restores the prior state, and reinstalling the prior version is an explicit rollback rather than an in-place overwrite.

Default roots:

- Windows versions: `%LOCALAPPDATA%\Programs\codegraph\<version>`; launcher: `%LOCALAPPDATA%\Programs\codegraph\bin\codegraph.cmd`
- macOS/Linux versions: `${XDG_DATA_HOME:-~/.local/share}/codegraph/<version>`; launcher: `${CODEGRAPH_BIN_DIR:-~/.local/bin}/codegraph`

Add the reported launcher directory to `PATH` if it is not already present. After installation, run `codegraph install`, then restart or reload the configured client.

## Option 2: Local source checkout

Use this path when you are developing on codegraph itself or want the least ambiguous first run.

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
codegraph doctor
codegraph install --all --dry-run
```

The `prepare` script reuses an existing `dist/` build during global installs because npm does not allow workspace builds in global package lifecycle scripts. If `dist/cli.js` or the published bin entry `dist/bin/cli.js` is missing, run `npm run build` before `npm install -g .`.

The `codegraph` bin points at the split ESM bundle under `dist/bin/`. Unbundled `dist/` modules remain available for tests and library imports.

## Local caches

The published bin stores Node's module compile cache outside the project root: `%LOCALAPPDATA%\codegraph\compile-cache` on Windows, or `$XDG_CACHE_HOME/codegraph/compile-cache` (falling back to `~/.cache/codegraph/compile-cache`) elsewhere. You can remove it at any time; the next startup may be slower, but command output is unchanged.

With disk caching enabled, codegraph creates `.codegraph-cache/index-v1/search-v1.sqlite` in each project. It contains normalized source and chunk text, so treat it as sensitive derived source data. Cache-off runs create no sidecar.

The first index-backed query may create or update this cache and report progress on stderr. Later queries reuse compatible state when `--root`, discovery configuration, graph options, and relevant build options match; use `--cache off` for a deliberate cold run.

To remove it safely, stop codegraph processes and delete `.codegraph-cache`. `uninit` leaves caches alone. [How it works](./how-it-works.md#cache-and-session-behavior) explains the cache mechanics.

## Option 3: Install from the `@lzehrung` registry

GitHub Packages requires authentication, including for public packages. Create a classic personal access token with `read:packages`, then authenticate and configure the scope:

```bash
npm login --scope=@lzehrung --auth-type=legacy --registry=https://npm.pkg.github.com
npm config set "@lzehrung:registry" "https://npm.pkg.github.com"
```

Use your GitHub username and the token as the password. Then install the main package:

```bash
npm install -g @lzehrung/codegraph
```

Then use codegraph-owned guidance to verify and configure clients:

```bash
codegraph doctor
codegraph install --all --dry-run
codegraph install --all --yes
```

npm cannot print package-authored completion guidance without lifecycle scripts, so run the explicit codegraph commands above after a global install or update.

The published path is native-first: `@lzehrung/codegraph` optionally resolves the matching native artifact automatically when a published binary exists for the current platform. Unsupported hosts use reduced graph-only mode. No separate grammar package is required.

## Option 4: Install from an npm release tarball

Download and install the root npm package tarball directly from a GitHub release:

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

1. Close or disconnect codegraph MCP clients.
2. Run `npm install -g @lzehrung/codegraph@latest`.
3. Restart the clients and run `codegraph doctor`.
4. Run `codegraph install --all --dry-run`, then `codegraph install --all --yes` if the preview is correct.

Later upgrades should not be blocked solely because codegraph mapped npm's native addon. Antivirus, backup software, or stale npm retirement directories can still cause `EBUSY`; `codegraph doctor` reports matching `.codegraph-*` siblings without deleting them.

An MCP server that survives an update continues running its captured version and warns when the installed version differs. Restart that client or shared server to use the new JavaScript runtime and native cache identity.

Old cache entries are inert after every process using them has stopped. Cleanup must be explicit: close codegraph clients first, then remove only obsolete version/hash directories under the fixed `v1` cache root; never overwrite or delete a mapped entry in place.

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

The initial [semantic corpus](./benchmarks/README.md#focused-semantic-regression-fixture) is informational and does not create an absolute accuracy threshold. Consult the release's machine-readable report before treating a package version or target as certified.

## Agent client setup

After installing the CLI, run `codegraph install` on an interactive terminal. It detects supported clients, previews the exact codegraph-owned changes, and asks once before writing:

```bash
codegraph install
codegraph install --target codex,claude --dry-run
codegraph install --target codex,claude --yes
codegraph install --all --dry-run
codegraph install --all --yes
codegraph install --print-config codex
```

Supported targets are `codex`, `claude`, `cursor`, `gemini`, `opencode`, `omp`, `kilo`, and `agents`. `--all` selects that full catalog in order without detection and cannot be combined with a target, `--detect`, or `--print-config`. OMP installs the managed skill under `.omp/agent/managed-skills/codegraph`; Kilo installs its skill under `.kilocode/skills/codegraph` and updates `.config/kilo/kilo.jsonc` without discarding comments.

Interactive confirmation accepts only `y` or `yes` and defaults to no; noninteractive writes require `--yes`. Existing compatible MCP entries and equivalent unmarked Codex tables are preserved byte-for-byte; divergent codegraph entries are reported as collisions without writing config. `uninstall` removes only codegraph-owned entries and leaves compatible pre-existing entries untouched.

The lower-level `codegraph skill install --agent <name>` command remains available when you only want to copy the bundled skill. Restart or reload configured MCP clients after installation.

## Next steps

- For CLI commands and examples, see [docs/cli.md](./cli.md).
- For library usage, see [docs/library-api.md](./library-api.md).
- For agent sessions, tool wrappers, and review flows, see [docs/agent-workflows.md](./agent-workflows.md).
