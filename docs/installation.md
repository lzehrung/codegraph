# Installation

Install `@lzehrung/codegraph` for the CLI, MCP server, viewer, and agent-client setup. For library-only TypeScript use, install [`@lzehrung/codegraph-core`](./library-api.md).

## Requirements

- npm and source installs require Node.js 22.16 or newer. Published installs need neither Rust nor a separate native-runtime step. Disk cache uses the Node.js standard-library `node:sqlite` module; builds below 22.16 may load it but omit statement APIs Codegraph needs, and those runs disable disk cache after one warning.
- The matching native runtime installs automatically when an artifact is available. Other hosts use reduced graph-only and regex recovery mode; see [CLI runtime selection](./cli.md#runtime-selection).
- Standalone archives bundle Node.js and support Windows, macOS, and glibc Linux on x64 and ARM64. Use npm or a source checkout on musl Linux. Windows ARM64 is structurally checked but not runtime-tested on matching hardware.

## Install from public npm (recommended)

```bash
npm install -g @lzehrung/codegraph
codegraph doctor
```

Public npm installs need no GitHub authentication, token, or registry mapping. If a user or project `.npmrc` still contains `@lzehrung:registry=https://npm.pkg.github.com`, remove or replace that legacy mapping first so npm uses the public release.

To update, run `npm install -g @lzehrung/codegraph@latest`, then restart any MCP clients and run `codegraph doctor`.

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

## Configure agent clients

After installing the CLI, preview the client configuration before writing it:

```bash
codegraph install
codegraph install --all --dry-run
codegraph install --all --yes
```

Use `--target codex,claude` to select clients. Interactive installation detects clients and defaults to no; noninteractive writes require `--yes`. Restart or reload configured clients after installation. See [MCP setup](./mcp.md) and [agent workflows](./agent-workflows.md) for configuration and usage.

## Next steps

- [CLI commands](./cli.md)
- [Library API](./library-api.md)
- [Agent workflows](./agent-workflows.md)
- [How it works](./how-it-works.md)
