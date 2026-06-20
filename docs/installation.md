# Installation

Requirements and install paths for local source checkouts, published packages, release tarballs, and runtime selection.

## Requirements

- Node.js 24.10+
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

The `prepare` script reuses an existing `dist/` build during global installs because npm does not allow workspace builds in global package lifecycle scripts. If `dist/cli.js` is missing, run `npm run build` before `npm install -g .`.

## Option 2: Install from the `@lzehrung` registry

Configure the scoped registry if you have not already:

```bash
npm config set "@lzehrung:registry" "https://npm.pkg.github.com"
```

Install the main package:

```bash
npm install @lzehrung/codegraph
```

That is the simplest published path for the native Tree-sitter runtime. `@lzehrung/codegraph` depends on `@lzehrung/codegraph-native` optionally, and that package resolves the matching native artifact automatically when a published binary exists for the current platform.

There is no separate grammar package to install. The published path is native-first: `@lzehrung/codegraph` optionally resolves `@lzehrung/codegraph-native` for the current platform, and unsupported hosts degrade to reduced graph-only mode.

## Option 3: Install from a release tarball

Download and install the root package tarball directly from a GitHub release:

```bash
npm install https://github.com/lzehrung/codegraph/releases/download/vVERSION/lzehrung-codegraph-VERSION.tgz
```

Replace `VERSION` with the desired release version from the GitHub release page.

Each release attaches a pre-built `.tgz` that `npm install` can consume by URL with no registry configuration needed for the root package itself.

Important: the tarball alone does not bundle the native addon. To analyze source languages after a tarball install, configure the `@lzehrung` registry so the optional `@lzehrung/codegraph-native` package can resolve for your platform.

Without the native runtime package, the CLI and library still install, but supported source languages run in reduced graph-only and regex recovery mode.

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

## Next steps

- For CLI commands and examples, see [docs/cli.md](./cli.md).
- For library usage, see [docs/library-api.md](./library-api.md).
- For agent sessions, tool wrappers, and review flows, see [docs/agent-workflows.md](./agent-workflows.md).
