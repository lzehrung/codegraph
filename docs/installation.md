# Installation

Requirements and install paths for local source checkouts, published packages, release tarballs, and runtime selection.

## Requirements

- Node.js 20+
- Published installs do not require Rust or a manual native setup step on supported targets.
- Local source checkouts do not require Rust just to build `dist/`, but the native workspace addon only builds when Cargo is available.
- If no compatible native artifact is available, install `@lzehrung/codegraph-js-fallback` to enable the opt-in JS Tree-sitter fallback path.
- Native-only installs do not need `@lzehrung/codegraph-js-fallback` for normal supported source-language graph extraction, symbol indexing, chunking, or AST grep.

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

If you explicitly want the JS Tree-sitter fallback path as well, install the separate opt-in package:

```bash
npm install @lzehrung/codegraph-js-fallback --legacy-peer-deps
```

`--legacy-peer-deps` is currently needed because `tree-sitter-kotlin` still publishes stale peer metadata even though the fallback stack works with the newer shared `tree-sitter` runtime used here.

## Option 3: Install from a release tarball

Download and install the root package tarball directly from a GitHub release:

```bash
npm install https://github.com/lzehrung/codegraph/releases/download/vVERSION/lzehrung-codegraph-VERSION.tgz
```

Replace `VERSION` with the desired release version, for example `1.8.53`.

Each release attaches a pre-built `.tgz` that `npm install` can consume by URL with no registry configuration needed for the root package itself.

Important: the tarball alone does not bundle the native addon or the optional JS fallback grammars. To analyze source languages after a tarball install, you still need one of these:

- Configure the `@lzehrung` registry so the optional `@lzehrung/codegraph-native` package can resolve for your platform.
- Configure the `@lzehrung` registry and install the separate `@lzehrung/codegraph-js-fallback` package explicitly if you want the non-native Tree-sitter path.

Without one of those extra runtime packages, the CLI and library still install, but source-language parsing features will report the native addon as unavailable.

## Native runtime modes

The runtime defaults to `native: "auto"`.

- `auto`: use the native Tree-sitter path when a compatible artifact is available and fall back automatically otherwise
- `on`: require native explicitly and fail if it is unavailable
- `off`: force the opt-in JS Tree-sitter fallback path

You can set `CODEGRAPH_DISABLE_NATIVE=1` to make `auto` prefer the optional JS fallback path by default when `@lzehrung/codegraph-js-fallback` is installed.

Explicit CLI, library, and tool `native` options take precedence over `CODEGRAPH_DISABLE_NATIVE`.

## Native vs JS fallback package roles

- `@lzehrung/codegraph`: main library and CLI
- `@lzehrung/codegraph-native`: optional native runtime package that resolves the matching binary artifact
- `@lzehrung/codegraph-js-fallback`: separate opt-in JS Tree-sitter runtime and grammar bundle

Native-only installs do not need the JS fallback package for normal supported source-language graph extraction, symbol indexing, chunking, or AST grep. If query recovery degrades in `auto` mode, Codegraph reports that once in diagnostics and uses the native-owned final recovery path where supported.

## Next steps

- For CLI commands and examples, see [docs/cli.md](./cli.md).
- For library usage, see [docs/library-api.md](./library-api.md).
- For agent sessions, tool wrappers, and review flows, see [docs/agent-workflows.md](./agent-workflows.md).
