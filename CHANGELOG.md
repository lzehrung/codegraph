# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

GitHub Releases remain the certified publish record. This file summarizes product-facing changes so the repository itself has a readable history.

## [Unreleased]

### Fixed

- TypeScript enum references include cross-file imports plus type-position and runtime-value uses. Extensionless imports whose basenames contain dots, such as `./statement-fund-col-groups.model`, now append supported source extensions instead of treating the final dotted segment as an explicit file extension.
- C++ callable resolution groups prototypes and definitions by signature instead of treating each declaration as a separate overload. Go-to-definition and references now select unique default-argument and variadic matches by accepted arity, keep same-file and included-header redeclarations in one reference set, preserve namespace-qualified free functions, and recognize explicit template member names such as `Box::run<int>`. Detailed symbol graphs emit one canonical node for same-file pairs and cross-file out-of-line member pairs without merging overloads. Persisted detailed graphs retain those canonical aliases, so warm cache validation accepts the merged nodes.
- PHP dependency extraction preserves `class`, `function`, and `const` import roles when the same target spelling appears in all three symbol namespaces. Graph construction no longer collapses those imports into one entry.
- C++ signature matching preserves pointer and reference operators while ignoring parameter names. Namespace exports use one visible-name representation across imports, navigation, references, and call graphs; explicit and inline-namespace aliases remain visible without leaking invalid bare names. Export resolution groups equivalent prototypes and definitions before publishing using aliases. Overlapping default-argument overloads remain unresolved, and member calls accept proven default and variadic ranges.
- C++ call arity is checked even when only one callable exists. Overloaded `using` aliases resolve through matching calls and references, including C++ `.h` headers, while same-signature functions from different namespaces remain distinct.
- Impact call-compatibility hints retain proven unqualified C++ calls whose argument counts no longer match a changed signature. These calls remain excluded from navigation, references, and call edges; shadowed names and ambiguous overloads are not attributed to the changed function. Equivalent same-file prototypes and definitions share compatibility hints and default arguments, including an in-class member prototype paired with its out-of-line definition on one type: both changed declaration sites report the member's resolved callsites, and a default argument declared only on the prototype applies to the definition. Member callsites are attributed only through receivers Codegraph already proves for navigation, so same-named members of unrelated types and same-scope member overload sets keep no hints.
- PHP navigation distinguishes type operands from constructor arguments when import aliases share a name. Method names match case-insensitively, while properties and class constants keep exact spelling. Bloom filtering preserves cross-file references to namespaced properties without accepting wrong-case property names.
- Kotlin and Swift member calls resolve when the member name is overloaded. Member arity was never computed for either language, because the arity pass kept a private parameter-node list that omitted Kotlin's `function_value_parameters`, and Swift declarations carry bare `parameter` children with no clause node. Exact arity is the only overload discriminator, so every ambiguous receiver call was dropped. Kotlin and Swift trailing closures now also count as arguments, matching what call-compatibility already reported for the same source.
- C++ union member functions get an owner, so receiver calls through a union resolve. A changed C# local function reports its own arity instead of the enclosing method's. C and C++ declarations treat a sole `void` parameter as zero arity, so overload selection resolves `pick()` to `pick(void)` instead of rejecting every candidate. Call hierarchy accepts a proven function-valued binding such as `const helper = () => 1` rather than rejecting it as an invalid target.
- PHP references find global-namespace symbols and case-variant spellings. A consumer without a `use` statement was never treated as a candidate file, and PHP class, function, and namespace names were compared case-sensitively although the language is not. A PHP `trait` is now a `class`-kind symbol, matching Rust: it previously collapsed to `variable` through the indexer's kind mapping, which made trait names compare case-sensitively and dropped legal case-variant references. Bloom filters now store ASCII-case-folded PHP identifiers and candidate narrowing folds probes for case-insensitive PHP kinds, so `new \App\sErViCe()` reaches the comparator without scanning every indexed PHP file. Go-to-definition applies the same folding while selecting PHP namespace, class-like, and function exports; constants and variables stay case-sensitive. Qualified function calls resolve their first segment through ordinary `use` namespace aliases; function-only imports remain specific to unqualified function names. Class, function, and constant imports that share a local alias remain in their separate PHP symbol namespaces, and constant aliases stay case-sensitive. Receiver call edges apply the same case-insensitive rule to PHP method names.
- `referenceCoverage` no longer reports `complete` when a reference strategy the definition's language requires never ran. It reports `partial` with the new `strategy_unavailable` or `name_equivalence_unavailable` reason, which `rename.safe` and impact consume.
- C and C++ quoted includes resolve against the including file's directory, matching the language rule. `#include "lib.h"` and `#include "inc/lib.h"` previously stayed external unless written as `./lib.h`, so dependency edges, go-to-definition, and find references all failed for ordinary C/C++ layouts. Reduced mode now preserves includes and C++ quoted or angle header-unit imports as import bindings instead of only file edges, so navigation and references still receive them when native capture is unavailable. C is also routed through the language import resolver for graph edges, which previously listed only C++.
- C and C++ angle includes try exact paths relative to configured search directories, without extension or index probing; macro includes remain external. Parent segments can reach another directory inside the project root, but cannot escape that root.
- C and C++ find references report call sites. A C-family function name is registered in its enclosing scope through the declarator chain instead of a missing `name` field, so it no longer lands inside its own body scope; same-file references previously returned only the declaration while still reporting `referenceCoverage.state: "complete"`. Parameter bindings are unaffected.
- Keyword receiver members navigate in every language that declares receiver keywords. `this.field`, `this->member`, and `self.target` previously returned `not_found` in C++, C#, Java, Kotlin, and Ruby, and resolved through the bare-name lexical path rather than member access in Swift. Own-type receivers now use the same ancestry model as detailed call graphs, including interfaces, PHP traits, and Ruby mixins.
- `super.helper()`, `base.Helper()`, and `parent::helper()` resolve to the base declaration. A supertype keyword receiver previously searched the current type and returned a same-named override in the deriving class. The walk now follows class ancestors only: C#, Kotlin, and Swift list the superclass and every interface or protocol in one base list, so an interface declaration could answer `base.Area()`.
- Receiver member navigation and call edges preserve JavaScript and TypeScript dynamic-`this` boundaries, lexical arrow receivers, static versus instance scope in TypeScript and Swift, inherited `this` calls, and C++ out-of-line member ownership. Computed `extends` expressions no longer create direct base edges. Find-references now verifies same-file member occurrences instead of accepting name-only scope hits and reports `strategy_unavailable` when a receiver type cannot be proven.

## [2.3.31] - 2026-09-21

### Changed

- Per-language member access, dynamic import folding, import binding, and call-compatibility behavior now lives in typed registries keyed by language id. Registry consistency tests reject missing or stale rows, with no change to indexing results.

## [2.3.30] - 2026-09-21

### Added

- JavaScript class inheritance is extracted. `class Child extends Base` now emits `extends` edges from the JavaScript grammar's `class_heritage` node, so supertypes, subtypes, implementations, and `super.m()` call edges work in `.js` files instead of returning empty results.
- Go interface embedding and struct embedding emit `implements` edges, so an embedded interface reports its implementers.
- Per-language declaration visibility filters module exports. Rust publishes only `pub`, `pub(crate)`, and `pub(super)` items; Java hides `private`; C# hides `private` everywhere and `internal` at namespace or file scope; Kotlin hides `private` and `internal`; Swift hides `private` and `fileprivate`; C and C++ hide a file-scope `static` storage class, while a `static` member inside a class or struct stays exported. A hidden declaration stays a file local with working same-file navigation, and it no longer binds through an import from another file. Python keeps `__all__` and underscore filtering, and a module-level `from a import *` is now an `exportStar` re-export, so `from b import name` resolves like an ECMAScript `export *`.
- C# method and constructor parameters are indexed as locals, matching Java and Kotlin, so they appear in symbol lists, navigation, rename, and impact. Java constructor declarations and `...` spread parameter names are recognized declaration names.
- Astro scoped `<style>` blocks contribute document edges: `@import "./theme.css"` and `url(./bg.png)` resolve like they do in HTML, Vue, and Svelte. Handlebars gains the same embedded-HTML coverage, and Markdown, MDX, and AsciiDoc walk the shared HTML forms instead of an `<a href>`-only subset.
- Ruby `require File.join(__dir__, "name")` and PHP computed `include`/`require` chains rooted at `__DIR__` or `dirname(__FILE__)` resolve under the opt-in dynamic-import heuristics, with non-foldable paths still ignored.
- AngularJS framework edges cover every JS-family file the registry resolves, so TypeScript, `.mjs`, `.cjs`, and `.jsx` projects get the same `templateUrl`, controller-name, and dependency-injection edges that `.js` projects had.
- JavaScript `import type` and `export type` statements produce type-only import bindings and type-only graph edges, matching TypeScript.

### Fixed

- First-party import resolution now realpath-confines targets while keeping the logical path, scopes Java, Kotlin, C#, PHP, and Python symbol indexes to the nearest language manifest file (a directory named `build.csproj/` is not a C# project) so a same-named package in a sibling workspace does not bind, and no longer treats a directory as a file edge unless the language runtime does (Python regular packages, PEP 420 namespace packages, and Go package directories). A leading U+FEFF is stripped from `tsconfig.json` and other resolution source text so BOM-prefixed path mappings still apply.
- Zig container members no longer leak into file scope. A `struct`, `union`, or `enum` member function is reachable through `Self.helper()`, `@This().helper()`, or an instance, and a bare `helper()` call inside the container now emits no edge and navigates to `not_found`.
- A file whose only line terminator is a lone carriage return reports real line numbers instead of placing every symbol on line 1.
- A source file over the native byte limit reports a structured `sourceTooLarge` fallback reason in the build report instead of only a warning log, so the downgrade is visible to callers.
- C++ modules declared in module-interface files (`.cppm`, `.ixx`, `.mxx`) now resolve. Neither the C++ language definition nor default discovery claimed those extensions, so the declaring file was never indexed, a first-party `import foo;` stayed external, and the declaration was invisible to incremental invalidation.
- Rust `pub(in path)` items are module exports, and `pub(self)` stays file-local, including spaced spellings such as `pub ( self )`.
- Extension-pattern manifest matches are deterministic. Two files matching `*.csproj` in one directory resolved by filesystem order, so the package root differed per machine and a cached index built on one disagreed with another. Selection now prefers a manifest whose name matches its directory, then falls back to name order, and Rust declaring-file candidates are sorted the same way.
- Media sources survive document extraction. Markdown, MDX, and AsciiDoc dropped every `<source>` element along with image syntax, so a `<video><source src="./clip.webm">` lost its edge; only `srcset` candidates are excluded now.
- The language-definition fingerprint recorded `membersAreImplicitlyInScope` with the wrong default, so a language flipping that field could reuse a stale cache.

### Changed

- Cross-language behavior that used to be copied per language now lives in shared tables, with no change to indexing results: one trivia lexer masks comments and strings for every language, scope node types and base-clause shapes are declared in tables rather than inlined branches, import queries share one compiler-enforced capture vocabulary (`@stmt` plus `@from`, with optional `@alias`, `@wild`, `@iname`, `@def`, `@ns`, and `@type_kw`), document formats run one embedded-HTML extractor driven by a per-format opt-out table, and dynamic-import heuristics share one constant-path fold.
- Unqualified member lookup inside a type body is now opt-in per language and enabled for Java, C#, Kotlin, Swift, Ruby, and C++, which is the set whose runtimes resolve a bare member name.
- The native addon no longer ships Vue and Svelte grammars. Single-file components already indexed through the embedded JavaScript, TypeScript, HTML, and CSS grammars, so the addon's supported-language set drops to 20 ids with no change to `.vue` or `.svelte` results.
- The package util surface exports `extractDynamicImportSpecifiers(languageId, source, fromFile, projectRoot)` in place of the undocumented `extractJsTsDynamicSpecifiers`.

## [2.3.29] - 2026-09-20

### Added

- Go receiver method calls resolve. A Go `method_declaration` now publishes a `member_of` edge to its receiver type, so `b.GoHelper()` produces a resolved `calls` edge for value, pointer, and `var`-declared receivers, and `callers`, `callees`, and impact report those call sites. A same-named package function is never attributed to a method, and interface-typed or factory-assigned receivers still emit nothing.
- Python receiver member navigation resolves `self` and `cls` members, attributes assigned in `__init__`, unique members inherited from declared bases, and locals assigned from a direct constructor call (`svc = Service()` or `svc: Service = Service()`). Python now appears in `diagnostics.memberResolutionCoverage.receiverAwareLanguages`; factory-assigned and unannotated-parameter receivers stay unresolved.
- C# namespace aliases resolve to first-party files. `using X = Project.Namespace;` contributes a dependency edge to every file declaring that namespace in block or file-scoped form, and a namespace declared in exactly one file also binds the alias, so member access through it navigates. A split namespace keeps the alias unresolved, and an external namespace such as `System.Collections.Generic` stays external.
- C# positional record components are indexed as variable locals, matching Java records, and `extern alias X;` is recognized as a local namespace alias with no dependency edge.
- SCSS go-to-definition and find references resolve same-file declarations and uses, including `$variable` reads, `@include` mixin names, and `@extend %placeholder`. Namespaced `@use` members and cross-file SCSS navigation stay unresolved.
- TypeScript and TSX named function expressions, including named generator function expressions, bind their own name inside the function body, matching JavaScript. The name is not exported and does not resolve from a sibling statement.
- C++20 module declarations are indexed: `export module foo;` publishes the module name, a first-party `import foo;` resolves to the declaring file like a `#include`, and `import std;` stays external. The C++ grammar is pinned to the upstream revision that exposes the module nodes.
- SQL impact mapping is object level. A changed SQL object becomes a changed symbol and impacts only files that read it, with a symbol-level reason; an unreferenced object in the same file no longer fans out to those readers, and unmapped statements still fall back to file-level impact.

### Fixed

- The generated fixture test matrix is current again. `npm run bench:fixtures:check` failed on the cross-language `tests/languages/query-hygiene.test.ts` stem instead of comparing counts, so `docs/benchmarks/fixture-snapshot.md` reported 256 tests while the suites ran 477. The check now runs in CI, and the generated snapshot JSON is excluded from Prettier so the format and freshness gates stop contradicting each other.

### Changed

- `docs/language-parity.md` now groups its capability notes by surface instead of one flat list, and corrects claims that no longer matched the code: `this.member` navigation resolves, reduced-mode regex import recovery is JavaScript/TypeScript only, `exports` publishes type members only for languages whose query captures them, and the Vue and Svelte native-addon cells state that single-file-component indexing uses the embedded JS/TS, HTML, and CSS grammars. Node.js, Java/Kotlin, and .NET project-name verdicts and the Gradle ignore default are fixed.

## [2.3.28] - 2026-09-20

### Fixed

- Cross-file reference searches now include resolved named and default import declaration tokens across supported languages. They preserve exact source-name and local-alias roles when both names have the same spelling, exclude names in comments and string literals, retain multi-line Python imports, ignore raw multiline-string contents and preserve qualified imports across nested comments in reduced-mode Kotlin, and avoid duplicate rename edits. Native and reduced CommonJS destructuring now ignore commas inside nested defaults. Rename previews treat partial reference coverage as unsafe.
- TypeScript and JavaScript receiver-member navigation now resolves enum members and valid static class fields without treating initializer reads, nested method locals, or type-only aliases as runtime class members. Declaration extraction also keeps Zig `extern const` variables, PHP constants with initializers, and Python destructuring targets accurate.
- Successful reference results now report complete or partial indexed-candidate coverage separately from target-definition confidence, including parser, unresolved-import, and exact truncation reasons.
- Detailed review summaries now apply callsite limits after excluding definition, import, and re-export declarations, report `callsiteCoverage` when the bounded usage scan is partial, and keep affected file paths project-relative.
- Cached parser, native, and fallback-import diagnostics now rebase file paths when a project cache moves with its project tree.

## [2.3.27] - 2026-09-15

### Fixed

- A `#[path]` module now resolves `super` against the module that actually declares it in the crate module tree, so an undeclared or generated `.rs` file no longer owns it when a Cargo crate root is reachable. The result no longer depends on directory-entry order in that case. When there is no Cargo root, no crate root, no reachable owner, or the tree is truncated, the prior directory scan still applies. The tree covers every Cargo target, including binaries, tests, examples, benches, and the build script. Default `src/lib.rs` is included when `[lib] path` is absent and either `[lib]` is explicit or `autolib` is not `false`; default `src/main.rs` and `src/bin` follow `autobins`. An explicit `[[bin]]`, `[[example]]`, `[[test]]`, or `[[bench]]` table without `path` still uses Cargo's default file for that name when auto-discovery is off. Crate-root files resolve child modules from their containing directory. Conventional module files that leave `--root`, including through a symlink, are not walked. Raw-identifier modules such as `mod r#type;` use the unescaped name. Explicit crate-root `path` values are kept even when they do not end in `.rs`. A virtual workspace manifest (`[workspace]` without `[package]`) contributes no package targets. Owner, reachable, and crate-root maps identify files with `fileIdentityKey`, so a `#[path]` spelling that differs only by case still matches the indexed file on a case-insensitive filesystem. Concurrent lookups after the revalidation interval share one freshness sweep instead of each repeating every crate-path `stat`. `cfg`-gated declarations of the same module name stay distinct.
- When two reachable modules declare the same `#[path]` target, `super` stays unresolved instead of picking one.
- Certified `release` and `standalone-release` workflows retry GitHub artifact upload and download after transient artifact-service errors such as DNS `ENOTFOUND`. Native matrix jobs keep `fail-fast: false` and a 30-minute timeout. Failure-report uploads still run after a failed command. The standalone workflow stores package candidates under a distinct artifact name so it does not replace certified `release-candidates`. After a failed run, use **Re-run failed jobs** on the same Actions run so successful native artifacts are reused.

## [2.3.26] - 2026-09-13

### Fixed

- Standalone installation on Windows survives a directory that a scanner or a departing process still holds open. `install.ps1` and the installer library now retry the staged version-root move for about nine seconds instead of under one, and removals retry as well.
- The standalone bundle smoke now runs against the published version root instead of the staged copy that is about to be renamed, so running `node.exe` no longer blocks the move that follows it. A staged copy that cannot be removed afterwards no longer fails an install that already completed.

## [2.3.25] - 2026-09-13

### Fixed

- Language queries now match the loaded grammars, preserve supported declaration forms, and exclude false CommonJS and function-local exports.
- Default discovery includes registered language aliases. HTML queries ignore tag and attribute case, Python `__all__` respects module scope and complete static lists, and TypeScript declaration exports resolve through imports.
- Import resolution now preserves commented Python imports, nested Rust uses and confined `#[path]` targets, stylesheet-relative paths, and per-specifier type-only bindings. C/C++ typedef names survive nested declarators. Rust text recovery ignores macro bodies, and a Python import behind a multi-line conditional is not a module re-export.
- Module exports drop names declared inside a function body, lambda, or closure while keeping members of nested top-level types. C/C++ exports again include include-guarded declarations, plus namespace, template, and prototype declarations, and an aliased Rust `pub use` keeps the original member as its source.
- Links to registered alias files resolve, so an `<a href="page.xhtml">` target inside the project is a file edge instead of an external reference.
- Duplicate masking includes Ruby `load`/`autoload` and Zig `@cImport`, with native and fallback handling. Ruby literal `load` and `autoload` calls remain masked with trailing comments. Kotlin duplicate queries use the loaded grammar's `import` node.
- Java method-, constructor-, and lambda-local classes no longer publish module exports. Ruby extension aliases retain standard-library import classification.
- Rust path attributes now follow the declaring module's scope and inline directory, preserve `]` in path strings, and exclude visible test-only imports.
- TypeScript inline-only type imports have type-only graph edges, and reduced-mode re-exports retain type flags. C/C++ capture-only extraction keeps typedef names without leaking function-local or static exports.
- Python imports after same-line top-level assignments and calls remain module re-exports.
- Document links now exclude comments, front matter, conditional AsciiDoc content, image alt text, and indented code after thematic breaks or inside blockquotes. Nested lists and continuation links inside blockquotes retain their source coordinates. Two blank lines end list indentation, and unclosed HTML comments mask the remaining document.
- Native query caches are bounded and release per-language capacity on eviction. Fallback diagnostics distinguish unavailable parsers from empty queries, name each fallback extraction path, and warn when a source language has no native grammar. `codegraph doctor` lists supported graph-only languages.
- Go-to-definition and references now resolve C# local functions from sibling statements and Go generic type parameters within their own declaration. C++ nested namespaces and unions are type symbols, and C++ concepts and preprocessor macros bind in the same file.
- Standard-library imports are classified from every registered extension of a language, so `.csx`, `.ktm`, and `.pyi` files no longer report their standard library as unresolved.
- Rust file graphs resolve `#[path]` modules declared inside inline modules, omit `#[cfg(test)]` modules when another attribute follows, and resolve `super` from a path-attributed module relative to its declaring module.
- A C include macro no longer creates a dependency, `#include HEADER` resolves again, a Ruby `load`/`autoload` argument must be a complete literal to be masked from duplicate scans, and a qualified Python `case module.CONST:` value no longer creates locals.
- Python module-level import detection agrees between native and reduced extraction, including an import after a multi-line parenthesized statement. `.h` classification treats `class`, `template`, and similar words used as plain C identifiers as C.
- Import-binding extraction reports the same fallback reason as graph extraction, so `native: "off"` no longer reports reduced mode for a language without regex recovery.
- Rust graph extraction keeps conditional `#[path]` modules with the same module name distinct. TypeScript type-only imports tolerate comments and compact `type{...}` clauses, and C header classification recognizes function calls that use C++ keywords as C identifiers.

## [2.3.24] - 2026-09-10

### Fixed

- `codegraph duplicates` now reuses a fresh project index when its duplicate scan glob filters change.

## [2.3.23] - 2026-09-09

### Fixed

- `codegraph duplicates` now removes import declarations and directives from every supported import syntax before matching duplicate units.

## [2.3.22] - 2026-09-09

### Added

- Exported `orientCodegraphWithSession` and `getCodegraphPacketWithSession` from the public agent entrypoint (`@lzehrung/codegraph-core/agent` and `@lzehrung/codegraph/agent`) for shared-session orientation and packet retrieval.

### Changed

- Shortened the bundled Codegraph skill around agent tool choice, task order, and safety checks. Detailed command and server contracts remain in the CLI and MCP references.
- MCP `get_symbol` now resolves its target without computing discarded explanation context or re-reading SQL sources. Target matching and ambiguity handling are unchanged.

### Fixed

- Detailed call hierarchy edges now resolve direct identifiers through lexical scope at the callsite. Nested declarations and local bindings no longer incorrectly target same-named module locals or imports.
- The `release` action now moves `[Unreleased]` notes into the new version automatically and includes them in its release commit. A separate changelog preparation commit is no longer required.
- Indexed text search now ranks complete-term candidates before bounded partial candidates, so a later exact match is not hidden by path-ordered SQL retrieval. Search responses separately disclose bounded indexed-text candidate omissions and lower-bound counts.
- Long indexed-text queries no longer exceed SQLite parameter or expression-depth limits. Retrieval keeps all terms and prioritizes complete matches before capped partial matches.
- Changing or reordering resolution hints, TypeScript `baseUrl`/`paths` (including `extends`), or workspace package exports now keeps cached import targets and graph edges consistent. This also applies when `resolveNodeModules` is disabled. Existing affected caches rebuild before reuse.
- Type hierarchy now excludes generic arguments and enclosing-type qualifiers from inheritance edges. Generic and qualified Java superclasses now retain their `extends` edge.
- Long-lived agent sessions now detect configuration-only changes before reusing a snapshot. Resolution, language, discovery, and ignore-rule changes now report stale state or refresh automatically according to the session freshness policy. Failed configuration checks report stale state without repeated automatic rebuilds or raw filesystem paths in the reason. Freshness respects `useConfig: false` without ignoring language config or ignore files.
- Path-only search and session file discovery now track lightweight file signatures before full project loading, allowing file additions, deletions, and renames to refresh automatically without forcing semantic indexing. Freshness checks also detect deletions during initial signature capture.

### Security

- Updated transitive Hono to 4.13.7 to clear three production security advisories.

## [2.3.21] - 2026-09-05

### Fixed

- Whole-project `codegraph index` now reuses Git-aware incremental discovery instead of resolving and discarding a separate CLI file list.
- Git candidate discovery now remains enabled when the project root is also the gitignore root, avoiding a full filesystem walk for ordinary whole-project indexes.
- Published builds now start the configured native worker pool. The bundled CLI previously left `--workers` ineffective because Piscina could not locate its worker from esbuild's ESM output.
- `codegraph init` and `codegraph sync` name post-index work in progress output instead of appearing to hang after the build completes.

### Changed

- `--report` names incremental preamble and manifest substeps so cold-index time is attributable to file identity, config hashing, Git, cache, and manifest work.
- `codegraph init` and `codegraph sync` reuse the config hash that their index build persisted, avoiding a redundant hash within the same command.
- Index builds share config, source, and metadata discovery within one operation. Git-backed config hashing reads root manifests and applicable ignore files without a recursive config scan.

## [2.3.19] - 2026-09-04

### Fixed

- `callers` now reports method invocations on a proven receiver (`this.m()`, `$this->m()`, `self::m()`, `const l = new Lib(); l.target()`), including inherited members. `this`/`$this`/`self` walk `extends`, `implements`, `trait`, and `mixin`; `super`/`base`/`parent` follow class `extends` ancestors only. Those sites previously resolved through `goto` but stored no `calls` edge. An unproven receiver still emits no edge. Ruby `super` is a same-name keyword, not a receiver. Go receiver methods remain a documented gap because Go declares methods outside the receiver type ([#341](https://github.com/lzehrung/codegraph/pull/341)).

## [2.3.18] - 2026-09-04

### Changed

- Thin snapshot hydrate now expands star-kind imports after loading SQLite module bodies, then freezes the in-memory index. Disk cache rows are stored before that expansion, so skipping it made incremental updates throw when they tried to mutate frozen imports.
- Index manifests are now compact JSON. Pretty-print (`JSON.stringify(..., null, 2)`) made the on-disk index `manifest.json` larger without changing load, which uses `JSON.parse`. Pretty files from earlier versions continue to work.

## [2.3.17] - 2026-09-04

### Changed

- Incremental index updates now record `snapshot-write` in `--report` timings, matching the full-build persistence steps. A one-file refresh previously rewrote the whole project snapshot without naming or timing that cost.
- Project snapshots no longer embed every parsed module. Unchanged module bodies hydrate from the SQLite disk cache; JSON stubs and other non-cache rows stay in the thin snapshot. A one-file refresh no longer re-serializes the full module corpus. Version 10 snapshots that still embed module bodies continue to load.

## [2.3.16] - 2026-09-03

### Added

- `codegraph orient` now supports `--report` and `--report-file`, matching other agent commands.

### Changed

- `codegraph mcp serve` (and `codegraph server start`, which spawns it) now warms the base session cache at startup by default, matching the old `--warmup` behavior. Previously startup was lazy by default, so an agent's first MCP tool call paid for cold discovery and building; on a large project that could exceed a client's tool-call timeout before the server ever produced a result. Pass `--no-warmup` for the old lazy startup, or `--warmup-symbols` to also warm the detailed symbol graph. Programmatic callers that supply their own `session` to `serveCodegraphMcp`/`startCodegraphMcpHttpServer` keep the previous lazy default unless they pass `warmup` explicitly.
- The default MCP per-tool execution deadline (`mcpToolTimeoutMs`) dropped from 30 minutes to 5 minutes. A stuck tool call previously held its concurrency slot for up to 30 minutes; 5 minutes is generous for any real Codegraph query while surfacing a hang far sooner. This is independent of `httpBodyTimeoutMs` (still 30 seconds), which only bounds receiving the HTTP request body.
- Index builds now name each post-parse persistence phase (`Writing disk cache`, `Resolving workspace manifests`, `Writing index manifest`, `Finalizing project graph`, `Writing project snapshot`) instead of leaving progress frozen at the last file count once parsing finishes. `--report` timings now include a `steps` array covering `persist-cache`, `workspace-manifests`, `index-manifest`, `finalize`, and `snapshot-write` durations.
- Progress lines that carry a file count now show elapsed time for the current phase, for example `[Progress] Resolving workspace manifests: 41/41 files. (5s)`. Applies to both the interactive spinner and redirected log output.

### Fixed

- The `Writing disk cache` post-parse phase no longer reports or times a persistence step when the cache mode is not `disk`. Every cacheable file still produces a pending cache-write entry regardless of mode, so this phase previously fired (and misleadingly named itself "disk") even with `--cache off` or `--cache memory`.
- Reused `--report` objects no longer accumulate stale post-parse persistence steps (`persist-cache`, `workspace-manifests`, `index-manifest`, `finalize`, `snapshot-write`) from a prior build. A caller that reuses one `BuildReport` object across builds - for example an MCP session's `buildOptions.report` across `refresh_index` calls - previously saw these steps pile up in `timings.steps`.
- Redirected log progress no longer prints a duplicate line when a phase change and a milestone count land on the same update, for example printing only `[Progress] Writing disk cache: 41/41 files. (0ms)` instead of that line preceded by a separate `[Progress] Writing disk cache.` line.

## [2.3.15] - 2026-09-03

### Changed

- Cold index progress now names file-cache checks after discovery. The spinner used to stay on `Checking project metadata files` while Git signatures, SQLite cache probes, and worker startup ran, so a cold init looked stuck on metadata after file listing had already finished. `--report` timings now include `cacheProbeMs` and a `cache-probe` step.

### Fixed

- Project metadata discovery no longer realpaths every ancestor directory of Git-listed data files. Only directories whose names can be project metadata (`.idea`, `App.xcodeproj`) are probed.
- Reused `--report` objects no longer keep leftover `cacheProbeMs` after a later build skips cache probes.
- Windows CLI processes no longer abort after a successful warm `explore` on Node 24. The second query printed a valid result, then libuv asserted `UV_HANDLE_CLOSING` while sqlite, native, or worker handles were still closing and the process exited `3221226505`. The CLI now lets those handles finish closing before the process exits.

## [2.3.14] - 2026-09-03

### Fixed

- A persisted detailed symbol graph is no longer treated as corrupt because it contains extra edges beyond the basic graph. The second `explore` in the Windows package funnel rebuilt that sidecar, printed a valid result, then aborted during process teardown (`UV_HANDLE_CLOSING`).
- Git ignore-file listing no longer walks gitignored trees looking for nested `.gitignore` files. After Git lists tracked and untracked candidates, discovery stats `.gitignore` only on those files' ancestor directories. A Python repo with a large gitignored data tree timed out on `Listing Git ignore files` even though file listing had already finished, because `git ls-files --others --ignored` descended into that tree.

## [2.3.13] - 2026-09-02

### Added

- `--report` index timings now include optional `gitListMs`, `filesystemScanMs`, and a `steps` list of named discovery durations so a slow cold init can be diagnosed without guessing which listing hung. Reusing the same report object replaces `sourceDiscoveryMs`, `metadataDiscoveryMs`, and those listing fields for the current build instead of keeping leftover values from a step that did not run.

### Changed

- Cold discovery progress now names Git listing, ignore-file listing, and filesystem scan fallback. A long sit used to stay on `Discovering source files` until Git returned; the spinner now says which listing is running. A timeout during file or ignore listing warns before the filesystem scan and records that unfinished listing in `--report` `steps`. Timeouts from earlier Git probes do not record a `git-list` step.

## [2.3.12] - 2026-09-02

### Fixed

- Source discovery no longer stats every Git-listed file when looking for directory symlinks. A Python repo with thousands of JSON or CSV files paid one `lstat` per data file during the symlink probe; those files are skipped, while Git mode 120000 still screens extension-bearing directory links.

## [2.3.11] - 2026-09-02

### Fixed

- Disk cache no longer retries an unsupported `node:sqlite` runtime. Node builds below 22.16 load the module but omit statement APIs Codegraph needs, so a default-on disk cache previously reopened the database and printed a stack on every cache access. The run now disables disk cache after one in-memory probe and prints one warning.
- Package funnel install no longer hangs on Windows GitHub runners. Isolated npm used to install drive-qualified tarballs from a different volume through an empty cache, so Git tar treated the drive letter as a remote host and npm fetched every native platform packument until the 300s budget killed the job. The funnel now copies candidates onto the isolation volume, prefers the local cache, and restricts optional natives to the host OS and CPU.

## [2.3.10] - 2026-09-01

### Fixed

- Source and metadata discovery no longer resolve a physical path for Git candidates the project excludes. A project holding a large untracked or ignored tree, such as a Python virtualenv, paid one filesystem syscall per excluded file: a 20,000-file virtualenv spent 1.68s in discovery to return 7 source files, and now spends 0.48s.
- `orient`, `explore`, `search`, and other agent-session commands now report counted discovery work. Cold discovery previously printed one `Discovering source files` line and no further output until it finished, which was indistinguishable from a hang.
- `Built project index: N files in X` now measures the whole index operation, including discovery. It previously started timing at the first parsed file, so a build that spent minutes discovering files and seconds parsing them reported only the seconds.

## [2.3.9] - 2026-09-01

### Added

- `--dynamic-import-heuristics` now uses shared language adapters for top-level and embedded code, and Python dependency graphs can add heuristic edges for static-string `importlib.import_module(...)` and `__import__(...)` calls.

### Changed

- Header language classification no longer samples `.h` bytes when C and C++ would produce the same result, so native-worker eligibility and SQL corpus filters skip those reads.
- Query indexing, duplicate analysis, lazy symbols, and package-resolution paths classify from source text they already hold. Go, Java, and Kotlin package names reuse retained parsed source.

## [2.3.8] - 2026-08-31

### Changed

- Cold discovery progress starts before agent-session file planning, so `Discovering source files` appears before symlink and source-path checks. Warm full-cache checks stay quiet.

## [2.3.7] - 2026-08-31

### Changed

- Cold discovery lists `.gitignore` sources through Git instead of statting every candidate ancestor, and reports source and metadata discovery time when a caller supplies a build report.

## [2.3.6] - 2026-08-31

### Changed

- `orient` now lists each focus path once and gives one `codegraph packet get <path>` example.
- `explore` no longer repeats its first follow-up as `Recommended next:`.
- Top-level CLI help and agent guidance start with `orient`, then direct search and navigation commands.

## [2.3.5] - 2026-08-31

### Changed

- Clarified `explore` as one hybrid search plus context from top results, not a planner or runtime proof.
- Agent, CLI, MCP, and library guidance now prefer `orient`, search, references, and call hierarchy before `explore`.

## [2.3.4] - 2026-08-30

### Changed

- Cold index progress now identifies source and metadata discovery, with completed path-check counts when available.

### Fixed

- Release-candidate package funnels now skip lifecycle scripts while installing certified tarballs, avoiding Windows install timeouts.

## [2.3.3] - 2026-08-30

### Changed

- Release package smoke now inspects certified tarballs directly, reuses extracted file records,
  prefers the npm cache, and leaves temporary installs for ephemeral runner cleanup.
- Disk cache writes copy only module fields whose paths change; cache reads transform their
  private parsed payload in place instead of deep-cloning every module.
- Worker-eligible cold builds now construct reference bloom filters in native extraction workers,
  parallelizing identifier hashing instead of doing it on the main thread. Automatic native worker
  sizing now caps at eight threads and preserves system capacity by default.
- Native language extraction now attempts one parsed-tree traversal for imports, exports, locals,
  and import bindings. It keeps independent traversals when the combined query cannot safely run.
- Project metadata discovery now reuses the Git file listing that source discovery already
  produced and omits Git-ignored manifests. An explicitly requested Git-ignored root keeps the
  filesystem fallback and can return ignored metadata.
- Query index preparation now runs in-process for small batches and only starts a worker pool
  once a batch is large enough to amortize thread startup, so incremental updates and small
  projects no longer pay for spawning and tearing down worker threads. Hosts that resolve to a
  single worker always prepare in-process, since one worker pays the startup cost without
  parallelizing anything.

### Fixed

- Duplicate fingerprints no longer depend on the host Node build's Unicode version. The
  TypeScript tokenizer read Unicode property escapes while the native tokenizer is pinned to
  Unicode 16, so on Node builds carrying newer Unicode data the two disagreed on characters such
  as U+088F and the same file fingerprinted differently with and without the native addon. The
  TypeScript grammar now comes from generated ranges pinned to the native tokenizer's version,
  and the duplicate-unit cache revision moves with it so units tokenized by the previous grammar
  are recomputed rather than reused.
- `packages/codegraph-native/Cargo.lock` is committed instead of ignored, so the published native
  binaries build from a reproducible dependency graph.
- Windows package smoke forces drive-qualified tarball paths to be local archives, preventing
  Git for Windows tar from treating the drive letter as a remote archive host.

## [2.3.2] - 2026-08-28

### Changed

- Clean disk-cache builds now skip module lookups when the cache database does not exist, while
  preserving per-file miss accounting ([#302](https://github.com/lzehrung/codegraph/pull/302)).

## [2.3.1] - 2026-08-28

### Changed

- Release candidate assembly now runs only source-quality checks and one package build, leaving
  tests, security, fixture, and package certification to their dedicated release jobs
  ([#301](https://github.com/lzehrung/codegraph/pull/301)).

### Fixed

- The certified release workflow now generates and validates its final committed lock under Node
  22/npm 10, matching the minimum supported CI runtime
  ([#300](https://github.com/lzehrung/codegraph/pull/300)).

## [2.3.0] - 2026-08-28

### Changed

- MCP tool responses now use compact JSON, `explore` omits source by default, and follow-ups are
  deduplicated and limited to callable MCP tools
  ([#286](https://github.com/lzehrung/codegraph/pull/286)).
- CLI help and validation are grouped more clearly, dependency traversal is bounded by default,
  graph JSON is deterministic, and long index checks emit a delayed progress heartbeat
  ([#287](https://github.com/lzehrung/codegraph/pull/287)).
- Detailed graph cache comparison now avoids temporary edge maps and repeated string allocation
  ([#290](https://github.com/lzehrung/codegraph/pull/290)).

### Fixed

- Pinned standalone release-script lock generation and validation to npm 10.9.2.

### Removed

- Removed four unused low-level facade exports and added a deterministic snapshot guard for future
  public API changes ([#288](https://github.com/lzehrung/codegraph/pull/288)).

## [2.2.3] - 2026-08-28

### Changed

- Cold discovery now uses Git-aware file enumeration, cached repository facts, grouped ignore
  matching, and bounded symlink screening. On the measured Unreal project, discovery fell from
  26.1 seconds to 1.0-1.4 seconds with the same 3,841 files
  ([#293](https://github.com/lzehrung/codegraph/pull/293),
  [#297](https://github.com/lzehrung/codegraph/pull/297)).
- Project-local state now lives under one `.codegraph/` directory, with disk caches in
  `.codegraph/cache/index-v1/`. Existing project and repository caches migrate automatically
  ([#296](https://github.com/lzehrung/codegraph/pull/296)).

### Fixed

- Release commits now normalize and verify the exact lockfile immediately before staging it,
  preventing later manifest or publication steps from committing a host-pruned dependency graph
  ([#294](https://github.com/lzehrung/codegraph/pull/294)).

## [2.2.2] - 2026-08-27

### Changed

- Stabilized cache implementation fingerprints, reused hydrated snapshots without cloning, and
  reported cache invalidation causes more clearly
  ([#283](https://github.com/lzehrung/codegraph/pull/283)).
- Reduced index and navigation work while preserving nested tsconfig aliases and resolved re-export
  targets ([#292](https://github.com/lzehrung/codegraph/pull/292)).

### Fixed

- Restored optional emnapi lockfile entries required by clean installs and added a pre-publication
  `npm ci` lockfile gate
  ([#289](https://github.com/lzehrung/codegraph/pull/289),
  [#291](https://github.com/lzehrung/codegraph/pull/291)).

## [2.2.1] - 2026-08-27

### Fixed

- Corrected Markdown link checks for aliased project roots and kept cached symlink hints confined to
  the requested root.

## [2.2.0] - 2026-08-26

### Added

- Added `codegraph server start|status|stop` for one project-local, loopback-only MCP HTTP server,
  with health checks, per-user credentials, startup diagnostics, and explicit restart behavior
  ([#281](https://github.com/lzehrung/codegraph/pull/281)).

### Changed

- Added columnar native syntax-tree encoding and removed a redundant parse
  ([#276](https://github.com/lzehrung/codegraph/pull/276)).
- Reduced native addon loading, hashing, and worker startup on warm and incremental runs, and removed
  cached addon versions unused for one month
  ([#278](https://github.com/lzehrung/codegraph/pull/278)).
- Enforced `@typescript-eslint/no-unused-vars` as an error with `^_` ignore patterns.

### Removed

- Removed the inert non-native parser seam, unread extraction parameters, and leftover declarations
  that no code used. Existing caches rebuild once after the fingerprint change
  ([#277](https://github.com/lzehrung/codegraph/pull/277)).

### Fixed

- Removed an unreachable `parseAgentSqlHandle` branch that could have skipped decoding.
- Retried transient Windows filesystem failures during standalone installation and restored a
  clean-installable npm lockfile.

## [2.1.2] - 2026-08-19

### Fixed

- Repaired CLI and artifact contracts: SQLite artifacts tolerate unsigned nodes, validation errors consistently use exit code `2`, documented MCP idle timeout parsing works, and graph output/cache options are applied consistently ([#269](https://github.com/lzehrung/codegraph/pull/269)).
- Restored TSX, Python package, JVM, inherited-tsconfig, Unicode search, and rename-preview semantic behavior; agent outputs now preserve freshness and bounded-result metadata ([#270](https://github.com/lzehrung/codegraph/pull/270)).
- Made MCP malformed input, unknown tools, cancellation, HTTP concurrency, artifact serialization, and SQLite authorization report correct, safe protocol behavior ([#271](https://github.com/lzehrung/codegraph/pull/271)).
- Corrected impact/review severity, omissions, truncation, fan-out, and Git-diff handling; hardened portable cache, sidecar, worker, and query-index behavior ([#272](https://github.com/lzehrung/codegraph/pull/272), [#273](https://github.com/lzehrung/codegraph/pull/273)).
- Hardened resumable release publication, installer rollback and TOML ownership, native staging, and CI contract coverage ([#274](https://github.com/lzehrung/codegraph/pull/274)).
- Allowed recursive read-only SQLite queries without permitting writes.

## [2.1.1] - 2026-08-19

### Fixed

- Made cache identities root- and implementation-aware, prevented stale cross-project reuse, and kept resolver, native, and query-index caches valid across updates ([#261](https://github.com/lzehrung/codegraph/pull/261), [#268](https://github.com/lzehrung/codegraph/pull/268)).
- Stabilized CLI output and public API documentation, restored parsed-cache insertion, and improved impact/review result accuracy ([#253](https://github.com/lzehrung/codegraph/pull/253)).
- Preserved Unicode identifier behavior in duplicate fingerprints and navigation, and bounded MCP body/session/query resources.

## [2.1.0] - 2026-08-14

### Changed

- Published certified packages through npm trusted publishing and made public npm installation the primary documented workflow ([#249](https://github.com/lzehrung/codegraph/pull/249)).

## [2.0.6] - 2026-08-11

### Fixed

- Corrected cache identity and project confinement, cross-language semantic resolution, impact ranking, capped-result metadata, and native CI coverage across the full-system review ([#246](https://github.com/lzehrung/codegraph/pull/246)).

## [2.0.5] - 2026-08-11

### Changed

- Discounted medium-confidence member references in impact/review risk ranking and reported limited member-resolution coverage ([#245](https://github.com/lzehrung/codegraph/pull/245)).

## [2.0.4] - 2026-08-10

### Added

- Added navigation, graph, and type-hierarchy coverage for class fields, Java/C# records, PHP/Ruby inheritance, Python match bindings, Rust grouped imports, Go embedding, and several SQL, RST, AngularJS, Swift, and C# constructs ([#237](https://github.com/lzehrung/codegraph/pull/237), [#238](https://github.com/lzehrung/codegraph/pull/238), [#239](https://github.com/lzehrung/codegraph/pull/239), [#240](https://github.com/lzehrung/codegraph/pull/240), [#241](https://github.com/lzehrung/codegraph/pull/241), [#242](https://github.com/lzehrung/codegraph/pull/242), [#243](https://github.com/lzehrung/codegraph/pull/243), [#244](https://github.com/lzehrung/codegraph/pull/244)).

## [2.0.3] - 2026-08-09

### Added

- Accepted qualified symbol paths in navigation commands ([#236](https://github.com/lzehrung/codegraph/pull/236)).

## [2.0.2] - 2026-08-09

### Fixed

- Included the core package in standalone releases and documented core-library workflows.

## [2.0.1] - 2026-08-09

### Fixed

- Certified planned release package versions before publication.

## [2.0.0] - 2026-08-09

### Added

- Published `@lzehrung/codegraph-core` as the slim library install (graphs/indexer/impact/agent helpers) without MCP SDK, installer-only deps, or viewer/skill assets.

### Breaking Changes

- Narrowed the root `@lzehrung/codegraph` export to core library primitives (indexing, graphs, impact, `CodeReviewSession`, SQLite/SQL, chunking, duplicates, drift, review, config, languages, native checks, and indexer `query*` aliases).
- Moved agent-shaped APIs (`createAgentSession`, explore/orient/search/explain/packet/file-view helpers, semantic hierarchy/rename/refactor helpers, and `tool_*` wrappers) to `@lzehrung/codegraph/agent`.
- Moved MCP handlers/server (`createCodegraphMcpHandlers`, `listCodegraphMcpTools`, `serveCodegraphMcp`) to `@lzehrung/codegraph/mcp`.
- Stopped exporting `formatAgentFollowUpAsCli` / `formatAgentFollowUpsAsCli` from public package entry points.
- Relocated package identity helpers from `src/cli/package-info.ts` to `src/util/package-info.ts` (internal path only).

### Migration

- Library-only consumers should install `@lzehrung/codegraph-core` (and its `./agent` subpath) instead of the full CLI/MCP package.
- Replace root imports of agent APIs with `@lzehrung/codegraph/agent` or `@lzehrung/codegraph-core/agent`.
- Replace root imports of MCP APIs with `@lzehrung/codegraph/mcp`.
- Import `toolFollowUp` / `AgentFollowUp` from the agent entrypoint when needed; do not depend on CLI follow-up string formatters.

## [1.8.111] - 2026-08-05

### Added

- `codegraph viewer` can load a current project graph automatically through the validated disk cache, without requiring an exported JSON file first ([#209](https://github.com/lzehrung/codegraph/pull/209)).

## [1.8.110] - 2026-08-04

### Changed

- Migrated the MCP server runtime to the Model Context Protocol TypeScript SDK v2 ([#208](https://github.com/lzehrung/codegraph/pull/208)).

## [1.8.109] - 2026-08-04

### Changed

- Improved graph viewer selection usability ([#206](https://github.com/lzehrung/codegraph/pull/206)).

## Earlier releases

See the [GitHub Releases](https://github.com/lzehrung/codegraph/releases) page for certified package versions, native package counterparts, checksums, and standalone preview assets.

[Unreleased]: https://github.com/lzehrung/codegraph/compare/v2.3.31...HEAD
[2.3.31]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.31
[2.3.30]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.30
[2.3.29]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.29
[2.3.28]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.28
[2.3.27]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.27
[2.3.26]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.26
[2.3.25]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.25
[2.3.24]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.24
[2.3.23]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.23
[2.3.22]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.22
[2.3.21]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.21
[2.3.19]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.19
[2.3.18]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.18
[2.3.17]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.17
[2.3.16]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.16
[2.3.15]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.15
[2.3.14]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.14
[2.3.13]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.13
[2.3.12]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.12
[2.3.11]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.11
[2.3.10]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.10
[2.3.9]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.9
[2.3.8]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.8
[2.3.7]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.7
[2.3.6]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.6
[2.3.5]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.5
[2.3.4]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.4
[2.3.3]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.3
[2.3.2]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.2
[2.3.1]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.1
[2.3.0]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.0
[2.2.3]: https://github.com/lzehrung/codegraph/releases/tag/v2.2.3
[2.2.2]: https://github.com/lzehrung/codegraph/releases/tag/v2.2.2
[2.2.1]: https://github.com/lzehrung/codegraph/releases/tag/v2.2.1
[2.2.0]: https://github.com/lzehrung/codegraph/releases/tag/v2.2.0
[2.1.2]: https://github.com/lzehrung/codegraph/releases/tag/v2.1.2
[2.1.1]: https://github.com/lzehrung/codegraph/releases/tag/v2.1.1
[2.1.0]: https://github.com/lzehrung/codegraph/releases/tag/v2.1.0
[2.0.6]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.6
[2.0.5]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.5
[2.0.4]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.4
[2.0.3]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.3
[2.0.2]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.2
[2.0.1]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.1
[2.0.0]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.0
[1.8.111]: https://github.com/lzehrung/codegraph/releases/tag/v1.8.111
[1.8.110]: https://github.com/lzehrung/codegraph/releases/tag/v1.8.110
[1.8.109]: https://github.com/lzehrung/codegraph/releases/tag/v1.8.109
