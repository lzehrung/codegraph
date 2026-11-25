# Installation

Install `@lzehrung/codegraph` for the CLI, MCP server, viewer, and agent-client setup. For library-only TypeScript use, install [`@lzehrung/codegraph-core`](./library-api.md).

## Requirements

- npm and source installs require Node.js 22.16 or newer. Published installs need neither Rust nor a separate native-runtime step. Disk cache uses the Node.js standard-library `node:sqlite` module; builds below 22.16 may load it but omit statement APIs Codegraph needs, and those runs disable disk cache after one warning.
- `@lzehrung/codegraph-native` is a required dependency. A compatible native artifact is required for analysis; if it cannot load, Codegraph returns an error instead of switching to reduced mode. Run `codegraph doctor` to inspect the installed runtime; it exits non-zero if the addon cannot load. See [native runtime](./cli.md#native-runtime).
- Native x64 addons use the x86-64/SSE2 baseline; AVX and AVX2 are not required. Node.js can impose a higher CPU baseline.
- Standalone archives bundle Node.js and support Windows, macOS, and glibc Linux on x64 and ARM64. Use npm or a source checkout on musl Linux. Windows ARM64 is structurally checked but not runtime-tested on matching hardware.

## Install from public npm (recommended)

```bash
npm install -g @lzehrung/codegraph
codegraph doctor
```

Public npm installs need no GitHub authentication, token, or registry mapping. If a user or project `.npmrc` still contains `@lzehrung:registry=https://npm.pkg.github.com`, remove or replace that legacy mapping first so npm uses the public release.

To update, run `npm install -g @lzehrung/codegraph@latest`, stop each shared owner with `codegraph server stop --root /path/to/repo`, then restart MCP clients and run `codegraph doctor`.

## Install the standalone preview

Use this when Node.js or npm is unavailable.

PowerShell:

```powershell
irm https://github.com/lzehrung/codegraph/releases/latest/download/install.ps1 | iex
```

POSIX shell:

```bash
curl -fsSL https://github.com/lzehrung/codegraph/releases/latest/download/install.sh | sh
```

Both installers preview the target and install path, then ask before writing. For unattended use, add `-Yes` in PowerShell or `--yes` in POSIX shell. They verify the release checksum before extraction and run `codegraph doctor` after installation.

Review, pin, or roll back a release by downloading the script and passing a version:

```powershell
Invoke-WebRequest https://github.com/lzehrung/codegraph/releases/latest/download/install.ps1 -OutFile ./install.ps1
Get-Content ./install.ps1
./install.ps1 -Version VERSION -Yes
```

```bash
curl -fsSL https://github.com/lzehrung/codegraph/releases/latest/download/install.sh -o ./install.sh
sh ./install.sh --version VERSION --yes
```

The installer keeps versioned roots and atomically switches the launcher, so reinstalling an earlier version is an explicit rollback. Add the reported launcher directory to `PATH` if necessary: `%LOCALAPPDATA%\Programs\codegraph\bin` on Windows or `${CODEGRAPH_BIN_DIR:-~/.local/bin}` on macOS and Linux.

## Use a source checkout

Use this path to develop codegraph or test a working-tree change.

```bash
git clone https://github.com/lzehrung/codegraph.git
cd codegraph
npm install
npm run build
node ./dist/cli.js doctor
```

Run checkout commands through `node ./dist/cli.js`. `npm run build` rebuilds `dist/` and builds the native workspace when Cargo is available; run `npm run build:native` when the native addon must build successfully. To use the global `codegraph` command instead, run `npm install -g .` after the build.

Building the native addon needs Rust 1.90 or newer, which the Tree-sitter 0.27 runtime requires; run `rustup update stable` when the build reports a crate that needs a newer `rustc`. It also needs Git access to `github.com/tree-sitter/tree-sitter-cpp` for the pinned C++ grammar and to `github.com/lzehrung/tree-sitter-kotlin` and `github.com/lzehrung/tree-sitter-typescript` for the pinned Kotlin and TypeScript grammar forks. A fully offline or registry-only Cargo environment cannot build the addon until those revisions ship in a release. Installing the published package is unaffected, because it ships prebuilt binaries.

`.cargo/config.toml` supplies defaults, but existing target-specific `CFLAGS_<target>` and `CXXFLAGS_<target>` values override them. Retain `-march=x86-64` for GNU/macOS, `/arch:SSE2` for MSVC, or `-mcpu=baseline` for Zig musl when setting those variables.

Cross-compiling the x64 musl addon also needs Zig 0.15.2, `cargo-zigbuild`, and the Rust `x86_64-unknown-linux-musl` target. Use Zig's explicit CPU flag, as the release build does; GCC's `-march=x86-64` spelling is not accepted by Zig:

```bash
CFLAGS_x86_64_unknown_linux_musl=-mcpu=baseline \
CXXFLAGS_x86_64_unknown_linux_musl=-mcpu=baseline \
node ./node_modules/@napi-rs/cli/dist/cli.js build --platform --release \
  --cwd packages/codegraph-native --output-dir ./artifacts --no-js --dts index.d.ts \
  --target x86_64-unknown-linux-musl -x
```

## Configure agent clients

After installing the CLI, preview the client configuration before writing it:

```bash
codegraph install
codegraph install --all --dry-run
codegraph install --all --yes
```

Use `--target codex,claude` to select clients. Interactive installation detects clients and defaults to no; noninteractive writes require `--yes`. Restart or reload configured clients after installation. See [MCP setup](./mcp.md) and [agent workflows](./agent-workflows.md) for configuration and usage.

`codegraph install` and `codegraph uninstall` hold a kernel lock whose persistent anchor lives under `installer-locks` in the per-user Codegraph state directory; uninstall keeps the anchors so concurrent waiters share one lock identity, and they are safe to delete when no Codegraph command is running. Installers with different state directories, or that cannot open an anchor (`NODE_DEBUG=codegraph` reports this on stderr), coordinate only through renewable leases, with the stale-observer window described for [lifecycle locks](./cli.md#shared-mcp-http-server). The native addon must support kernel locks; update or rebuild it if the command reports that lock support is missing.

## Next steps

- [CLI commands](./cli.md)
- [Library API](./library-api.md)
- [Agent workflows](./agent-workflows.md)
- [How it works](./how-it-works.md)
