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
