# Language coverage parity matrix

Status key:
- Yes = supported and covered
- Partial = supported with intentional limitations
- No = not supported for that capability

| Language | Dependency graph | Symbol extraction | Go-to-definition | Find references | Chunking | SFC integration | PR impact mapping | Native addon | Native parity tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TypeScript | Yes | Yes | Yes | Yes | Yes | No | Yes | Yes | Yes |
| TSX | Yes | Yes | Yes | Yes | Yes | No | Yes | Yes | Yes |
| JavaScript | Yes | Yes | Yes | Yes | Yes | No | Yes | Yes | Yes |
| Python | Yes | Yes | Yes | Yes | Yes | No | Yes | Yes | Yes |
| Go | Yes | Yes | Yes | Yes | Yes | No | Yes | Yes | Yes |
| Java | Yes | Yes | Yes | Yes | Yes | No | Yes | Yes | Yes |
| C | Yes | Yes | Yes | Yes | Yes | No | Yes | Yes | Yes |
| C++ | Yes | Yes | Yes | Yes | Yes | No | Yes | Yes | Yes |
| C# | Yes | Yes | Yes | Yes | Yes | No | Yes | Yes | Yes |
| Kotlin | Yes | Yes | Yes | Yes | Yes | No | Yes | Yes | Yes |
| Ruby | Yes | Yes | Yes | Yes | Yes | No | Yes | Yes | Yes |
| Rust | Yes | Yes | Yes | Yes | Yes | No | Yes | Yes | Yes |
| Swift | Yes | Yes | Yes | Yes | Yes | No | Yes | Yes | Yes |
| HTML | No | No | No | No | Yes | No | Yes | Yes | Yes |
| CSS | No | No | No | No | Yes | No | Yes | Yes | Yes |
| SCSS | Yes | No | No | No | Yes | No | Yes | Yes | Yes |
| Less | No | No | No | No | Yes | No | Yes | Yes | Yes |
| Vue | No | No | No | No | Yes | Yes | Yes | Yes | Yes |
| Svelte | No | No | No | No | Yes | Yes | Yes | Yes | Yes |

Notes:
- The native addon uses the same Tree-sitter query model as the JS path for all listed source languages.
- Native parity coverage includes both baseline fixtures and deeper syntax variants such as aliased and static imports, nested types, traits and protocols, typedefs and aliases, and SFC script variants.
- `SCSS` uses the native addon for import/specifier extraction. Native SCSS symbol queries are intentionally skipped because symbol extraction is not a supported SCSS capability yet.
- `HTML`, `CSS`, `Less`, `Vue`, and `Svelte` are graph/chunking-focused today. Their unsupported navigation and symbol features are covered by explicit `not_found` parity tests.

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
