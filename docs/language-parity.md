# Language coverage parity matrix

Status key:

- Yes = supported and covered
- Partial = supported with intentional limitations
- No = not supported for that capability

| Language         | Dependency graph | Symbol extraction | Go-to-definition | Find references | Chunking | SFC integration | PR impact mapping | Call compatibility | Native addon | Native parity tests |
| ---------------- | ---------------- | ----------------- | ---------------- | --------------- | -------- | --------------- | ----------------- | ------------------ | ------------ | ------------------- |
| TypeScript       | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| TSX              | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| JavaScript       | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| Python           | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| PHP              | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| Go               | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| Java             | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| C                | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| C++              | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| C#               | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| Kotlin           | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| Ruby             | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| Rust             | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| Swift            | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| Zig              | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| HTML             | Yes              | No                | No               | No              | Yes      | No              | Yes               | No                 | Yes          | Yes                 |
| Astro            | Yes              | No                | No               | No              | No       | No              | Yes               | No                 | No           | No                  |
| Handlebars       | Yes              | No                | No               | No              | No       | No              | Yes               | No                 | No           | No                  |
| CSS              | Yes              | No                | No               | No              | Yes      | No              | Yes               | No                 | Yes          | Yes                 |
| SCSS             | Yes              | No                | No               | No              | Yes      | No              | Yes               | No                 | Yes          | Yes                 |
| Less             | Yes              | No                | No               | No              | Yes      | No              | Yes               | No                 | Yes          | Yes                 |
| Markdown         | Yes              | No                | No               | No              | No       | No              | Yes               | No                 | No           | No                  |
| MDX              | Yes              | No                | No               | No              | No       | No              | Yes               | No                 | No           | No                  |
| reStructuredText | Yes              | No                | No               | No              | No       | No              | Yes               | No                 | No           | No                  |
| AsciiDoc         | Yes              | No                | No               | No              | No       | No              | Yes               | No                 | No           | No                  |
| Vue              | Yes              | No                | No               | No              | Yes      | Yes             | Yes               | No                 | Yes          | Yes                 |
| Svelte           | Yes              | No                | No               | No              | Yes      | Yes             | Yes               | No                 | Yes          | Yes                 |
| SQL              | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Partial           | No                 | Yes          | Yes                 |

The matrix states supported capability classes; it is not a measured accuracy table. The [semantic corpus](./benchmarks/README.md#semantic-correctness-corpus) publishes the currently measured subset by operation, language, repository, and native or reduced runtime, with support shown beside precision and recall.

The first release tier covers reviewed Go, Python, and TypeScript cases plus an explicit unsupported Markdown navigation case. Languages absent from that corpus retain their test-backed matrix status, but they have no semantic-corpus measurement yet.

Notes:

- The native addon is the only Tree-sitter grammar backend for the listed source languages.
- Without native, codegraph degrades to reduced graph-only and regex recovery mode; it does not switch to a JS grammar stack.
- Native parity tests cover source-language extraction and end-to-end semantics for `TypeScript`, `TSX`, `JavaScript`, `Python`, `PHP`, `Go`, `Java`, `C#`, `Rust`, `Kotlin`, `Swift`, `Zig`, `C`, `C++`, `Ruby`, and `SQL`. Graph/specifier parity is covered for `HTML`, `CSS`, `Less`, `SCSS`, `Vue`, and `Svelte`.
- JavaScript graphing has an AngularJS-only heuristic for `templateUrl`, controller-name, and DI-token file/external edges. It only applies when a file explicitly uses `angular.module(...)`; generic `controller` or `templateUrl` objects are not treated as Angular.
- Call compatibility hints compare changed callable arity with resolved callsites when parsing is high confidence. They are not type checking, overload resolution, trait dispatch, function-pointer analysis, macro expansion, or data-flow inference.
- Call compatibility skips same-file overload sets unless a future resolver can prove the exact overload target.
- JavaScript, TypeScript, TSX, and JSX call compatibility includes callable variable arrows with parenthesized parameters and single bare parameters such as `const helper = a => a`.
- Method-like declarations are indexed as function locals across supported source languages where the grammar exposes named methods or member functions. Body edits map to the method local, and parameter edits set method-level `signatureChanged` when the method signature is in scope.
- Receiver-aware method references cover JS/TS plus Java, C#, and Rust receiver forms that `goto` can verify, such as direct construction, typed locals, and Rust impl-backed locals. Method-level call compatibility remains JS/TS-only and is emitted only for verified receivers such as `new Service().run()` and `const service = new Service(); service.run()`.
- Public call-hierarchy parity fixtures prove resolved direct calls with exact callsites for TypeScript, Java, C#, Go, Rust, and Ruby. Svelte inline scripts also prove detailed `calls` edge extraction, but Svelte does not claim the full symbol-navigation surface.
- Call hierarchy follows only resolved `calls` edges between indexed callable symbols. It does not claim overload or virtual dispatch, trait/interface dispatch, function pointers, macros, reflection, dynamic sends, or name-only guesses; `includeHeuristic` is accepted but currently adds no edges.
- Reduced graph-only recovery does not claim call hierarchy parity. Imports, file dependencies, instantiations, decorators, inheritance, and ordinary references remain distinct edge or navigation surfaces.
- Type hierarchy fixtures prove TypeScript `extends`/`implements` and abstract overrides, Java `extends`/`implements`, C# base-list inheritance and interface conformance, Rust `impl Trait for Type`, Swift class inheritance and protocol conformance, C++ base-class clauses, Python class bases, and Kotlin delegation specifiers.
- These forms emit resolved `extends` or `implements` edges only when both declarations are indexed. External bases, structural or duck typing, dynamic mixins, protocol extensions, overload dispatch, and name-only member matches are not inferred.
- Hierarchy implementation lookup supports interface or trait members and declared abstract or virtual override targets with proven implementers. It returns exact declarations, deduplicates inherited non-overrides, rejects ambiguous overload identity, and does not claim reduced graph-only recovery parity.
- Rename preview and refactor-plan coverage follows the indexed symbol, reference, call, and hierarchy capabilities above; it is not a separate compiler-grade rename claim for every source language. `rename.safe` is conservative and authoritative for the returned plan, but unsupported dispatch, unresolved external symbols, ambiguous scopes, stale evidence, invalid live ranges, conflicts, and omissions keep it false or remain outside the plan.
- The deterministic refactor performance fixture is TypeScript-only and exercises operation scale and cache structure. It does not expand cross-language parity claims or establish universal latency.
- Duplicate detection compares same-language units only. Source languages with parser context can contribute AST-shape evidence for renamed structural clones; graph-first and text-only formats continue to use chunk, text, and token fingerprint signals without claiming AST-shape duplicate parity.
- `SCSS` uses the native addon for import/specifier extraction. Dependency graph resolution covers Sass partials for extensionless and explicit `.scss` specifiers, including non-canonical extension casing. Native SCSS symbol queries remain intentionally skipped because symbol extraction is not a supported SCSS capability in either runtime path yet.
- `HTML`, `CSS`, `Less`, `Vue`, and `Svelte` are graph/chunking-focused today. Their unsupported navigation and symbol features are covered by explicit `not_found` parity tests.
- `Markdown` and `MDX` are graph-first today. They use shared text extraction for document links and MDX static imports, and they intentionally do not claim semantic chunking, navigation, references, or native-addon parity yet.
- `Astro`, `Handlebars`, `reStructuredText`, and `AsciiDoc` are also graph-first today. They use shared text extraction for local links and format-specific include/import syntax, and they intentionally do not claim semantic chunking, navigation, references, or native-addon parity yet.
- `SQL` is supported as a repository language, not a full database analyzer. It discovers `.sql` files by default, chunks statements, extracts table/view/index/routine symbols, records common DDL/DML and CTE read/write facts, creates SQL-to-SQL object edges, and supports SQL-file go-to-definition and find-references.
- SQL object edges are exact for unique object-name matches. Qualified-to-basename fallback is heuristic and only used when unambiguous; ambiguous basename guesses are skipped.
- SQL navigation resolves schema-qualified names plus object-level `alias.column`, `table.column`, and `schema.table.column` references to table/view definitions when the prefix is unambiguous. It does not resolve specific column definitions.
- SQL explain targets use the same conservative rule: exact object names win, and unqualified basenames resolve only when unique. SQL does not infer a current schema from migrations, seeds, dumps, or fixtures.
- Application-code string literals are not globally linked to SQL objects. They only surface SQL facts through explicit review-context bridge rules.
- SQL indexing, graphing, and navigation are native-only and do not require the JS fallback package.
- C typedef reference recovery is limited to direct declaration use-site coverage. Macro-expanded or otherwise non-local typedef references are not claimed.
- C# alias-only `using Alias = Namespace.Type;` navigation is limited when there is no companion namespace import. Graph extraction is covered, but alias-only member navigation is not claimed yet.

## Project file discovery coverage

The status key describes project-name extraction only. File discovery and monorepo boundary handling are separate checks.

Status key:

- Yes = extracts a project name from metadata
- Partial = detects the project file, but the name falls back to the directory or filename
- No = not detected

| Ecosystem       | Project files                                                                                                                                                                                                            | Name extraction                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Node.js         | `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `tsconfig.json`, `jsconfig.json`, `pnpm-workspace.yaml`, `lerna.json`, `nx.json`, `turbo.json`                                          | Yes for `package.json`; workspace configs fall back to the directory name |
| Python          | `pyproject.toml`, `requirements.txt`, `requirements.in`, `Pipfile`, `Pipfile.lock`, `poetry.lock`, `setup.py`, `setup.cfg`                                                                                               | Yes for `pyproject.toml`, `setup.cfg`, and `setup.py`                     |
| Go              | `go.mod`, `go.sum`, `go.work`                                                                                                                                                                                            | Yes for `go.mod`                                                          |
| Rust            | `Cargo.toml`, `Cargo.lock`, `rust-toolchain`, `rust-toolchain.toml`                                                                                                                                                      | Yes for `Cargo.toml`                                                      |
| Java and Kotlin | `pom.xml`, `mvnw`, `build.gradle`, `build.gradle.kts`, `settings.gradle`, `settings.gradle.kts`, `gradle.properties`, `gradlew`                                                                                          | Yes for `pom.xml` and `settings.gradle`                                   |
| .NET            | `*.csproj`, `*.fsproj`, `*.vbproj`, `*.sln`, `Directory.Build.props`, `Directory.Build.targets`, `global.json`                                                                                                           | Yes for project files                                                     |
| Ruby            | `Gemfile`, `Gemfile.lock`, `*.gemspec`                                                                                                                                                                                   | Yes for `*.gemspec`; Partial for `Gemfile`                                |
| PHP             | `composer.json`, `composer.lock`                                                                                                                                                                                         | Yes for `composer.json`                                                   |
| Swift           | `Package.swift`, `Package.resolved`, `*.xcodeproj`, `*.xcworkspace`                                                                                                                                                      | Yes for `Package.swift`                                                   |
| C and C++       | `CMakeLists.txt`, `CMakePresets.json`, `CMakeUserPresets.json`, `Makefile`, `makefile`, `GNUmakefile`, `configure.ac`, `configure.in`, `meson.build`, `meson_options.txt`, `conanfile.txt`, `conanfile.py`, `vcpkg.json` | Yes for `vcpkg.json`; Partial for directory fallback cases                |
| IDE             | `.idea`                                                                                                                                                                                                                  | Partial via directory fallback                                            |

Monorepo and diagnostic behavior:

- Project file traversal stops at the nearest manifest boundary, so scoped scans do not inherit unrelated parent projects.
- `inspect` and `unresolved` use supported dependency manifests to suppress declared third-party packages from unresolved-import diagnostics.
- Graph-only document and template link edges still appear in graph output. They are excluded from unresolved-import diagnostics by default, so source import health is not mixed with documentation link checking.

## C/C++ resolution hints

Configure repo-local include roots with `graph.resolutionHints` in `codegraph.config.json` or CLI `--resolution-hint`. Hints are root-confined, participate in cache identity, and improve candidate-test linkage for layouts such as Unreal-style `Private/.../Tests` includes.
