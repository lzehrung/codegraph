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
| Swift | Package.swift | ✅ Package.swift |
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
- Swift: Package.swift
- IDE: .idea

## Parity completion plan

### SFC integration rollout

SFC integration should be standardized across all languages using the same ingestion pipeline, with language-specific adapters, shared fixtures, and strict metadata requirements.

1. **Define the SFC contract (all languages)**
   - **Inputs**
     - Required metadata: language, file path, logical module key, and SFC block identity (block index, block type, original range).
     - Parse options: strict vs lenient parsing, preprocessor hints (for example, `lang="ts"` or `lang="scss"`), and embedded language mappings.
     - Expected input sources: raw SFC file content and a pre-split list of blocks (script/template/style/custom).
   - **Outputs**
     - Symbols: block-scoped symbols with stable IDs that include the SFC block identity.
     - Chunks: chunk boundaries that do not cross block boundaries, with references back to the original SFC block range.
     - Dependency edges: edges that preserve both the underlying file path and the logical block type.
   - **Contract documentation**
     - Document the required fields, optional fields, error modes, and how fallback parsing should behave.
     - Add sample payloads for a few languages to show how block identity is preserved.
2. **Build shared fixtures**
   - For each language, add fixtures that cover:
     - Mixed language blocks (for example, template + script + style).
     - Preprocessor variants (`lang="ts"`, `lang="scss"`, `lang="less"`).
     - Edge cases like empty blocks, duplicate script blocks, custom blocks, and template-only SFCs.
   - Provide expected outputs (symbols, chunks, dependency edges) for each fixture.
3. **Build language adapters**
   - **TypeScript/TSX/JavaScript**
     - Reuse the existing parser pipeline.
     - Map script blocks to the existing TS/JS symbol extractor with block identity metadata.
     - Ensure chunking aligns with the current JSX/TSX behavior without crossing block boundaries.
   - **Python/Go/Java/C#/Ruby/Rust**
     - Implement a block-level adapter that injects block identity metadata into the parser entry point.
     - Preserve source ranges so go-to-definition and reference results can map back to the SFC block.
   - **HTML/CSS/SCSS/Less**
     - Implement markup/style adapters that preserve block boundaries in chunking.
     - Ensure selector or node outputs reference the correct SFC block range.
   - **Vue/Svelte**
     - Validate current integration against the contract.
     - Align metadata fields (block identity, ranges, language hints) with the unified pipeline.
4. **Validation + parity tracking**
   - Add contract conformance tests for each language adapter that compare fixture outputs to the expected outputs.
   - Ensure error handling is consistent (parse errors produce partial outputs + diagnostics, not silent failures).
   - Update the parity matrix once each adapter passes the shared SFC fixture suite.

### PR impact mapping rollout

PR impact mapping should be consistent across languages, with a shared rule engine for file classification, dependency traversal, and symbol-level impact.

1. **Define the PR impact contract (all languages)**
   - **Schema**
     - Changed files: path, change type (add/modify/delete/rename), and detected language(s).
     - Impacted symbols: stable symbol IDs, symbol kind, defining file, and impact reason.
     - Dependency reach: graph traversal path (direct vs transitive), edge types, and depth.
     - Chunk summaries: affected chunks with ranges and summaries that map back to source ranges.
   - **Edge cases**
     - Renamed files and moved modules.
     - Deleted symbols and orphaned references.
     - Generated files vs source-of-truth files (explicitly mark generated).
     - Multi-language change sets and SFC changes that touch multiple blocks.
2. **Build the shared rule engine**
   - File classification: detect language by extension plus SFC block metadata.
   - Dependency traversal: use the dependency graph for impact reach; prevent cycles and enforce max depth limits.
   - Symbol matching: resolve by stable IDs and, when missing, by name + location heuristics with explicit warnings.
3. **Language-specific dependency and symbol linkage**
   - **TypeScript/TSX/JavaScript/Python/Go/Java/C#/Ruby/Rust**
     - Ensure symbol extraction emits stable IDs that include file path + language + local symbol index.
     - Update dependency edges to include symbol-level linkage where available.
   - **HTML/CSS/SCSS/Less**
     - Define impact mapping in terms of selectors/components and map to dependent assets.
     - Connect selectors to JS/TS component usage if mappings exist (for example, CSS Modules).
   - **Vue/Svelte**
     - Connect component-level symbols to script/template/style blocks to preserve full impact coverage.
     - Ensure block identity is carried into impact results for SFCs.
4. **Validation + parity tracking**
   - Add PR impact fixtures that cover cross-file and cross-language changes.
   - Include fixtures for file renames, deletes, and generated file detection.
   - Update the parity matrix when a language passes the shared PR impact fixtures.

### Go go-to-definition

1. **Resolver contract**
   - Define the Go go-to-definition resolver interface that aligns with the existing symbol extraction model.
   - Specify inputs (source file, cursor position, module context) and outputs (definition range, file path, symbol ID).
2. **Parser + symbol linkage**
   - Extend Go symbol extraction to emit location-aware symbol IDs for packages, types, functions, methods, and variables.
   - Ensure symbol IDs are stable across rebuilds (avoid position-only IDs; include package path + name + kind).
3. **Module + workspace resolution**
   - Parse `go.mod` for module path, `replace` directives, and local module overrides.
   - Support vendor directories and standard library resolution.
   - Handle workspace layouts (`go.work`) with multiple modules.
4. **Resolver implementation steps**
   - Implement local file resolution (same package) first.
   - Add module dependency resolution using module path + package import mapping.
   - Add stdlib resolution using the local Go installation or a vendored stdlib index.
5. **Validation + parity tracking**
   - Add go-to-definition fixtures for stdlib, local module, and replaced module references.
   - Include fixtures for renamed imports, aliased imports, and method receivers.
   - Update the parity matrix once the fixtures pass.
