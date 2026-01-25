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

| Ecosystem | Detected project files | Name extraction |
| --- | --- | --- |
| Node.js | package.json, package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lockb, tsconfig.json, jsconfig.json, pnpm-workspace.yaml, lerna.json, nx.json, turbo.json | ✅ package.json |
| Python | pyproject.toml, requirements.txt, requirements.in, Pipfile, Pipfile.lock, poetry.lock, setup.py, setup.cfg | ✅ pyproject.toml/setup.cfg/setup.py |
| Go | go.mod, go.sum, go.work | ✅ go.mod |
| Rust | Cargo.toml, Cargo.lock, rust-toolchain, rust-toolchain.toml | ✅ Cargo.toml |
| Java/Kotlin | pom.xml, mvnw, build.gradle, build.gradle.kts, settings.gradle, settings.gradle.kts, gradle.properties, gradlew | ✅ pom.xml/settings.gradle |
| .NET | *.csproj, *.fsproj, *.vbproj, *.sln, Directory.Build.props, Directory.Build.targets, global.json | ✅ *proj |
| Ruby | Gemfile, Gemfile.lock, *.gemspec | ✅ *.gemspec, ⌛ Gemfile |
| PHP | composer.json, composer.lock | ✅ composer.json |
| Swift | Package.swift, Package.resolved, *.xcodeproj, *.xcworkspace | ✅ Package.swift |
| C/C++ | CMakeLists.txt, CMakePresets.json, CMakeUserPresets.json, Makefile, makefile, GNUmakefile, configure.ac, configure.in, meson.build, meson_options.txt, conanfile.txt, conanfile.py, vcpkg.json | ✅ vcpkg.json, ⌛ directory fallback |
| IDE | .idea | ⌛ directory fallback |

### Project file list (discovery)

- Node.js: package.json, package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lockb, tsconfig.json, jsconfig.json, pnpm-workspace.yaml, lerna.json, nx.json, turbo.json
- Python: pyproject.toml, requirements.txt, requirements.in, Pipfile, Pipfile.lock, poetry.lock, setup.py, setup.cfg
- Go: go.mod, go.sum, go.work
- Rust: Cargo.toml, Cargo.lock, rust-toolchain, rust-toolchain.toml
- Java/Kotlin: pom.xml, mvnw, build.gradle, build.gradle.kts, settings.gradle, settings.gradle.kts, gradle.properties, gradlew
- .NET: *.csproj, *.fsproj, *.vbproj, *.sln, Directory.Build.props, Directory.Build.targets, global.json
- Ruby: Gemfile, Gemfile.lock, *.gemspec
- PHP: composer.json, composer.lock
- Swift: Package.swift, Package.resolved, *.xcodeproj, *.xcworkspace
- C/C++: CMakeLists.txt, CMakePresets.json, CMakeUserPresets.json, Makefile, makefile, GNUmakefile, configure.ac, configure.in, meson.build, meson_options.txt, conanfile.txt, conanfile.py, vcpkg.json
- IDE: .idea
