# Language coverage parity matrix

Status key:

- Yes = supported and covered
- Partial = supported with intentional limitations
- No = not supported for that capability

| Language         | Dependency graph | Symbol extraction | Go-to-definition | Find references | Chunking | SFC integration | PR impact mapping | Native addon | Native parity tests |
| ---------------- | ---------------- | ----------------- | ---------------- | --------------- | -------- | --------------- | ----------------- | ------------ | ------------------- |
| TypeScript       | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes          | Yes                 |
| TSX              | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes          | Yes                 |
| JavaScript       | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes          | Yes                 |
| Python           | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes          | Yes                 |
| PHP              | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes          | Yes                 |
| Go               | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes          | Yes                 |
| Java             | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes          | Yes                 |
| C                | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes          | Yes                 |
| C++              | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes          | Yes                 |
| C#               | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes          | Yes                 |
| Kotlin           | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes          | Yes                 |
| Ruby             | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes          | Yes                 |
| Rust             | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes          | Yes                 |
| Swift            | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes          | Yes                 |
| Zig              | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes          | Yes                 |
| HTML             | Yes              | No                | No               | No              | Yes      | No              | Yes               | Yes          | Yes                 |
| Astro            | Yes              | No                | No               | No              | No       | No              | Yes               | No           | No                  |
| Handlebars       | Yes              | No                | No               | No              | No       | No              | Yes               | No           | No                  |
| CSS              | No               | No                | No               | No              | Yes      | No              | Yes               | Yes          | Yes                 |
| SCSS             | Yes              | No                | No               | No              | Yes      | No              | Yes               | Yes          | Yes                 |
| Less             | No               | No                | No               | No              | Yes      | No              | Yes               | Yes          | Yes                 |
| Markdown         | Yes              | No                | No               | No              | No       | No              | Yes               | No           | No                  |
| MDX              | Yes              | No                | No               | No              | No       | No              | Yes               | No           | No                  |
| reStructuredText | Yes              | No                | No               | No              | No       | No              | Yes               | No           | No                  |
| AsciiDoc         | Yes              | No                | No               | No              | No       | No              | Yes               | No           | No                  |
| Vue              | No               | No                | No               | No              | Yes      | Yes             | Yes               | Yes          | Yes                 |
| Svelte           | No               | No                | No               | No              | Yes      | Yes             | Yes               | Yes          | Yes                 |

Notes:

- The native addon uses the same Tree-sitter query model as the opt-in `@lzehrung/codegraph-js-fallback` path for all listed source languages.
- Native-only installs do not require `@lzehrung/codegraph-js-fallback` for normal supported source-language graph extraction, symbol indexing, chunking, or AST grep. When query recovery degrades in `auto` mode, Codegraph reports it in diagnostics and stays on native-owned recovery paths where the language supports them.
- Native parity coverage includes both extraction parity and end-to-end semantic parity on the current source-language fixture set (`TypeScript`, `TSX`, `JavaScript`, `Python`, `PHP`, `Go`, `Java`, `C#`, `Rust`, `Kotlin`, `Swift`, `Zig`, `C`, `C++`, `Ruby`) plus graph/specifier parity for `HTML`, `CSS`, `Less`, `SCSS`, `Vue`, and `Svelte`.
- Deeper hardening coverage now includes Go aliased imports and interface-typed uses, Kotlin alias and wildcard imports plus package-wide wildcard graph expansion and native-owned import-binding recovery, Java wildcard-import package fixtures plus package-wide graph expansion and static wildcard imports, Rust aliased `use` imports plus `extern crate` graph fixtures, C# alias-using graph fixtures, Python `from __future__ import ...` import extraction, PHP grouped `use` imports, bracketed namespace blocks, `__DIR__` include resolution, fully-qualified Composer-backed class/static/type references, function/class basename collision handling, and Composer `psr-0`, `psr-4`, `autoload-dev`, `classmap`, `exclude-from-classmap`, and `autoload.files` resolution with classmap-boundary enforcement, Swift static-member fixtures, Zig `@import` namespace member fixtures, C function-pointer typedef fixtures, C++ namespace/template fixtures, and Ruby nested module fixtures.
- JavaScript graphing now includes an isolated AngularJS heuristic layer for `templateUrl`, controller-name, and DI-token file/external edges when a file explicitly uses `angular.module(...)`. This coverage lives in dedicated framework tests, not in the generic JavaScript fixture set, and it is not a general claim that arbitrary `controller` or `templateUrl` config objects are Angular-aware.
- `SCSS` uses the native addon for import/specifier extraction. Native SCSS symbol queries remain intentionally skipped because symbol extraction is not a supported SCSS capability in either runtime path yet.
- `HTML`, `CSS`, `Less`, `Vue`, and `Svelte` are graph/chunking-focused today. Their unsupported navigation and symbol features are covered by explicit `not_found` parity tests.
- `Markdown` and `MDX` are graph-first today. They use shared text extraction for document links and MDX static imports, and they intentionally do not claim semantic chunking, navigation, references, or native-addon parity yet.
- `Astro`, `Handlebars`, `reStructuredText`, and `AsciiDoc` are also graph-first today. They use shared text extraction for local links and format-specific include/import syntax, and they intentionally do not claim semantic chunking, navigation, references, or native-addon parity yet.
- One deeper semantic shape remains intentionally limited and is covered by explicit regression tests instead of an optimistic support claim: macro-expanded or otherwise non-local C typedef reference recovery beyond the current direct declaration use-site coverage.
- Another intentionally limited semantic shape is C# alias-only `using Alias = Namespace.Type;` navigation without a companion namespace import. Graph extraction is covered, but alias-only member navigation is not claimed yet.

## Project file discovery coverage

Status key:

- Yes = extracts a project name from metadata
- Partial = detected, but name falls back to directory or filename
- No = not detected

- Node.js: `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `tsconfig.json`, `jsconfig.json`, `pnpm-workspace.yaml`, `lerna.json`, `nx.json`, `turbo.json`. Name extraction: Yes for `package.json`; workspace configs fall back to the directory name.
- Python: `pyproject.toml`, `requirements.txt`, `requirements.in`, `Pipfile`, `Pipfile.lock`, `poetry.lock`, `setup.py`, `setup.cfg`. Name extraction: Yes for `pyproject.toml`, `setup.cfg`, and `setup.py`.
- Go: `go.mod`, `go.sum`, `go.work`. Name extraction: Yes for `go.mod`.
- Rust: `Cargo.toml`, `Cargo.lock`, `rust-toolchain`, `rust-toolchain.toml`. Name extraction: Yes for `Cargo.toml`.
- Java and Kotlin: `pom.xml`, `mvnw`, `build.gradle`, `build.gradle.kts`, `settings.gradle`, `settings.gradle.kts`, `gradle.properties`, `gradlew`. Name extraction: Yes for `pom.xml` and `settings.gradle`.
- .NET: `*.csproj`, `*.fsproj`, `*.vbproj`, `*.sln`, `Directory.Build.props`, `Directory.Build.targets`, `global.json`. Name extraction: Yes for project files.
- Ruby: `Gemfile`, `Gemfile.lock`, `*.gemspec`. Name extraction: Yes for `*.gemspec`, Partial for `Gemfile`.
- PHP: `composer.json`, `composer.lock`. Name extraction: Yes for `composer.json`.
- Swift: `Package.swift`, `Package.resolved`, `*.xcodeproj`, `*.xcworkspace`. Name extraction: Yes for `Package.swift`.
- C and C++: `CMakeLists.txt`, `CMakePresets.json`, `CMakeUserPresets.json`, `Makefile`, `makefile`, `GNUmakefile`, `configure.ac`, `configure.in`, `meson.build`, `meson_options.txt`, `conanfile.txt`, `conanfile.py`, `vcpkg.json`. Name extraction: Yes for `vcpkg.json`, Partial for directory fallback cases.
- IDE: `.idea`. Name extraction: Partial via directory fallback.
