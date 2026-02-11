# Language coverage parity matrix

Status key: ✅ = Covered, ⌛ = Partial, ❌ = Missing.

| Language | Dependency graph | Symbol extraction | Go-to-definition | Find references | Chunking | SFC integration | PR impact mapping |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TypeScript | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| TSX | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| JavaScript | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Python | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Go | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Java | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| C | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| C++ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| C# | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Kotlin | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Ruby | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Rust | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Swift | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| HTML | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| CSS | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| SCSS | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| Less | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| Vue | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| Svelte | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |

## Project file discovery coverage

Status key: ✅ = Extracts name from metadata, ⌛ = Directory/filename fallback, ❌ = Not detected.

- Node.js: package.json, package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lockb, tsconfig.json, jsconfig.json, pnpm-workspace.yaml, lerna.json, nx.json, turbo.json. Name extraction: ✅ package.json (workspace configs fall back to directory name).
- Python: pyproject.toml, requirements.txt, requirements.in, Pipfile, Pipfile.lock, poetry.lock, setup.py, setup.cfg. Name extraction: ✅ pyproject.toml/setup.cfg/setup.py.
- Go: go.mod, go.sum, go.work. Name extraction: ✅ go.mod.
- Rust: Cargo.toml, Cargo.lock, rust-toolchain, rust-toolchain.toml. Name extraction: ✅ Cargo.toml.
- Java/Kotlin: pom.xml, mvnw, build.gradle, build.gradle.kts, settings.gradle, settings.gradle.kts, gradle.properties, gradlew. Name extraction: ✅ pom.xml/settings.gradle.
- .NET: *.csproj, *.fsproj, *.vbproj, *.sln, Directory.Build.props, Directory.Build.targets, global.json. Name extraction: ✅ *proj.
- Ruby: Gemfile, Gemfile.lock, *.gemspec. Name extraction: ✅ *.gemspec, ⌛ Gemfile.
- PHP: composer.json, composer.lock. Name extraction: ✅ composer.json.
- Swift: Package.swift, Package.resolved, *.xcodeproj, *.xcworkspace. Name extraction: ✅ Package.swift.
- C/C++: CMakeLists.txt, CMakePresets.json, CMakeUserPresets.json, Makefile, makefile, GNUmakefile, configure.ac, configure.in, meson.build, meson_options.txt, conanfile.txt, conanfile.py, vcpkg.json. Name extraction: ✅ vcpkg.json, ⌛ directory fallback.
- IDE: .idea. Name extraction: ⌛ directory fallback.


## F4/F6 impact-analysis neutrality matrix

Status key: ✅ = Works now, ⌛ = Works with ecosystem-specific constraints, ❌ = Not applicable.

| Capability | TypeScript/JavaScript | Python | Go | Java/C#/Ruby/Rust/Kotlin/Swift/C/C++ | Vue/Svelte script blocks | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| F4 config-impact baseline detection (`configImpact`) | ✅ | ✅ | ✅ | ✅ | ✅ | File-path driven and independent of source language once config file matches recognized patterns. |
| F4 tsconfig/jsconfig alias blast-radius mapping | ✅ | ⌛ | ⌛ | ⌛ | ✅ | Alias mapping is specific to TS/JS alias conventions and import specifier matching. |
| F4 build-tool semantic classification (vite/webpack/rollup/esbuild) | ✅ | ⌛ | ⌛ | ⌛ | ✅ | Build-tool configs are JS/TS ecosystem oriented; still emitted regardless of repository source language mix. |
| F4 monorepo tool semantic classification (turbo/nx) | ✅ | ⌛ | ⌛ | ⌛ | ✅ | Monorepo-tool semantics are ecosystem specific but suggestions remain cross-language at repo level. |
| F6 untested-change suggestions from symbol refs | ✅ | ✅ | ✅ | ✅ | ✅ | Depends on symbol/ref extraction quality for each language parser. |
| F6 LCOV ingestion | ✅ | ✅ | ✅ | ✅ | ✅ | Coverage format driven; language neutral if file paths and line numbers map. |
| F6 Istanbul JSON ingestion | ✅ | ✅ | ✅ | ✅ | ✅ | Statement-map parsing is language neutral at line level. |
| F6 confidence calibration (coverage + export + fan-in + symbol kind) | ✅ | ✅ | ✅ | ✅ | ✅ | Calibration uses graph/symbol metadata, not language-specific rules. |
| F6 repository-specific command templates | ✅ | ✅ | ✅ | ✅ | ✅ | Uses optional template and package-manager inference from manifest files. |
