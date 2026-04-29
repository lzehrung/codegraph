# PHP Language Support Design

**Goal:** Add PHP as a first-class source language in Codegraph with full parity across dependency graphing, symbol extraction, go-to-definition, find-references, chunking, native runtime support, JS fallback support, and project/package metadata handling.

## Scope

This design covers:

- PHP source-file support
- PHP project/package file support already present through `composer.json` and `composer.lock`
- Composer-aware resolution needed to make PHP source navigation practical in real projects
- Documentation and regression coverage needed to keep PHP support honest
- A reusable checklist for adding future languages with the same standards

This design does not try to solve:

- Dynamic runtime-only include resolution
- Full Composer behavior emulation beyond what can be resolved statically
- PHP framework-specific heuristics in the initial milestone

## Current State

The repo already supports PHP project-file discovery:

- `composer.json` and `composer.lock` are part of `DEFAULT_PROJECT_MANIFESTS`
- PHP project-file discovery is typed as `type: "php"`
- `tests/project-file-discovery.test.ts` already verifies `composer.json` naming

The repo does not yet support PHP as a source language:

- no PHP language definition under `src/languages/definitions`
- no PHP registration in `src/languages/all.ts`
- no PHP chunking config registration in `src/bootstrap/treeSitterLanguages.ts`
- no PHP fixtures under `tests/samples`
- no PHP language test under `tests/languages`
- no PHP native runtime wiring in `packages/codegraph-native`
- no PHP JS fallback grammar dependency

This means the repo currently recognizes PHP package metadata but cannot parse PHP source files semantically.

## User-Level Outcome

After this work:

- PHP files should be discovered as source files by default
- PHP files should participate in graph building, indexing, chunking, impact analysis, and symbol-detailed output
- PHP imports and file-loading forms should resolve as broadly as is realistic from static analysis
- PHP go-to-definition and find-references should behave consistently with the current shared pipeline for other source languages
- Native and JS fallback execution paths should stay aligned through parity tests
- Docs should describe PHP support precisely, including any explicit limitations

## Design Principles

- PHP should land as a normal source language, not a graph-only exception
- Reuse the existing shared indexing/navigation pipeline wherever possible
- Add narrow PHP-specific logic only where PHP syntax or resolution semantics genuinely differ
- Prefer practical static support for common PHP patterns over speculative support for rare dynamic behavior
- Every claimed capability must be backed by fixtures and tests in the same change

## Capability Surface

### Dependency Graph

Initial PHP graph support should include:

- `require`
- `require_once`
- `include`
- `include_once`
- namespace/class imports through `use`
- grouped `use` forms
- aliased imports
- function imports
- constant imports

Resolution should support:

- direct relative and absolute path-like include targets
- extension-aware local file resolution where authored paths omit `.php`
- local resolution for conventional `index.php` entrypoints and package-root file targets when they are statically addressable
- Composer-aware static mappings from `composer.json` when those mappings can identify concrete files or namespace roots

Dynamic expressions such as string concatenation, variable includes, or runtime-computed paths should not be overclaimed. They may remain unresolved or external.

### Symbol Extraction

Initial PHP symbol coverage should include:

- namespaces
- classes
- interfaces
- traits
- enums
- methods
- functions
- top-level constants

Additional symbols to include in the same milestone when they map cleanly onto the existing shared symbol model:

- class constants
- properties

The first implementation should not distort the symbol model just to claim more PHP coverage.

### Go-To-Definition and Find-References

PHP semantic navigation should support:

- local definitions in the same file
- symbols imported with `use`
- namespace-qualified symbol references
- references reached through included/required files when the target file resolves statically
- Composer-autoloaded classes/functions when the mapping is statically resolvable

Navigation should explicitly avoid optimistic claims for:

- runtime-computed includes
- ambiguous autoload mappings with multiple plausible targets and no deterministic winner
- framework container resolution or reflection-heavy patterns

### Chunking

PHP chunking should cover:

- namespace blocks
- classes
- interfaces
- traits
- enums
- methods
- functions
- important top-level declarations where they already fit the chunk model

Docblocks or comments should only be chunked if they align with existing repo conventions for source languages and do not create PHP-only chunk noise.

## Resolution Strategy

PHP needs a layered resolution model.

### Layer 1: Direct File Loading

Support static path-like file loading via:

- `require`
- `require_once`
- `include`
- `include_once`

This layer should use the existing repository path-resolution utilities where possible, extended for PHP source conventions such as omitted `.php` extensions.

### Layer 2: Namespace Imports

Support semantic imports from `use` statements:

- single imports
- aliases
- grouped imports
- function imports
- constant imports

This layer should feed the shared import-binding and symbol-resolution pipeline rather than creating a separate PHP-only navigation system.

### Layer 3: Composer-Aware Resolution

Support the most practical Composer metadata in `composer.json`, prioritizing:

- `autoload.psr-4`
- `autoload-dev.psr-4`
- `autoload.psr-0`
- `autoload-dev.psr-0`
- `autoload.classmap`
- `autoload-dev.classmap`
- `autoload.files`
- `autoload-dev.files`

Behavior expectations:

- PSR mappings should map namespaces to source roots and allow deterministic class/file resolution when the file layout matches the namespace path
- `classmap` and `files` should influence graph edges where the target files are explicit and local
- `autoload-dev` should be included because repo navigation and tests usually operate on the whole checkout, not publish-only package contents

This should remain static and deterministic. Codegraph should not attempt to run Composer or generate autoload files.

## Runtime Architecture

### TypeScript Language Definition

Add `src/languages/definitions/php.ts` implementing the normal `LanguageDefinition` contract:

- file extensions
- grammar loader
- chunking structure
- graph queries for imports, exports, locals, and import bindings
- declaration classification helpers
- scope helpers
- node-type hints used by the shared resolution pipeline

PHP should then be registered in:

- `src/languages/all.ts`
- `src/bootstrap/treeSitterLanguages.ts`

### JS Fallback Path

Add the PHP Tree-sitter grammar dependency to the JS fallback package and ensure `loadTreeSitterLanguage` can resolve it under the existing loader model.

This keeps `native: "off"` and native-fallback parity aligned with the rest of the repo.

### Native Runtime Path

Add PHP grammar support to `packages/codegraph-native`:

- Rust dependency in `Cargo.toml`
- `language_for_id` mapping in `src/lib.rs`
- supported language id list
- smoke and parity coverage that already protects the other languages

The native runtime should execute the same query model as the JS path and stay within the current ownership boundary: native runs parse/query work, TypeScript keeps the higher-level indexing and navigation logic.

## Test Design

PHP support should ship with overlapping coverage, not just a single suite.

### Fixtures

Add a `tests/samples/php` fixture set covering at least:

- include and require variants
- namespace imports
- aliases
- grouped `use` imports
- function and constant imports if supported
- cross-file classes and functions
- Composer PSR mapping cases
- Composer classmap/files cases when useful
- a deeper semantic fixture with multiple files and namespace boundaries, not only trivial examples

Add a `tests/languages/samples/php.sample.php` chunking fixture for direct structural chunk assertions.

### Language-Specific Tests

Add `tests/languages/php.test.ts` covering:

- chunk extraction
- dependency graph edges
- symbol extraction
- go-to-definition
- find-references

### Shared Semantic Tests

Update shared suites so PHP is a real peer language:

- `tests/goto.test.ts`
- `tests/references.test.ts`
- `tests/native-semantic-parity.test.ts`
- native-vs-JS parity suites such as `tests/native-tree-sitter.test.ts`
- parser ownership / fallback ownership suites where the current source languages participate

### Resolution and Metadata Tests

Add focused tests for Composer-aware resolution behavior rather than treating `tests/project-file-discovery.test.ts` as sufficient proof.

Needed coverage should include:

- `composer.json` namespace mapping affects symbol resolution
- explicit `autoload.files` entries create graph edges when local
- unsupported or ambiguous dynamic shapes do not create false-positive edges

### Documentation Tests

The docs themselves are not executable, but the change should treat documentation accuracy as a contract:

- every claimed PHP capability in `docs/language-parity.md` must map to an actual test
- every meaningful syntax/resolution scenario should appear in `docs/scenario-catalog.md`

## Documentation Changes

The implementation should update:

- `docs/language-parity.md`
- `docs/scenario-catalog.md`
- `README.md` if supported-language claims or extension guidance change
- `codegraph-skill/codegraph/SKILL.md` if the supported language surface or examples need updating

PHP support claims must be exact. If a syntax form or Composer behavior is intentionally unsupported, the docs should say so plainly.

## Risks and Mitigations

### Risk: Overclaiming Composer Support

Composer behavior is broader than what static analysis can prove.

Mitigation:

- only claim static support for deterministic local mappings
- document dynamic/runtime-only limitations explicitly
- add negative tests for unsupported dynamic patterns

### Risk: Native and JS Grammar Differences

PHP query behavior may differ across runtime paths.

Mitigation:

- add parity tests early
- keep language queries minimal and explicit
- add a PHP-specific native query normalization hook only when parity tests prove the raw query shape diverges between runtimes

### Risk: Polluting the Shared Indexing Pipeline

PHP-specific recovery logic could turn into ad hoc branching.

Mitigation:

- keep PHP-specific logic isolated to import extraction and resolution seams
- reuse existing symbol/navigation machinery after bindings are normalized

### Risk: False Positives From Includes

Naive include handling can produce incorrect file edges.

Mitigation:

- only resolve static string targets
- avoid optimistic interpretation of dynamic expressions
- add fixtures that prove the unresolved behavior stays conservative

## Definition of Done

PHP support is complete for this milestone when:

- PHP is registered as a source language in both JS fallback and native paths
- PHP files are discovered as source files by default
- graph, symbols, goto, refs, and chunking work on the PHP fixture set
- Composer-aware static resolution is implemented for the supported metadata shapes
- native and JS fallback parity suites include PHP
- `docs/language-parity.md` and `docs/scenario-catalog.md` are updated in the same change
- a reusable language-addition checklist exists and reflects the actual PHP rollout work

## Reusable Checklist: Adding a New Source Language

Use this checklist for future language additions.

### 1. Discovery and Registration

- Add source file extensions to default discovery when the language is not already covered there
- Add the language definition under `src/languages/definitions`
- Register it in `src/languages/all.ts`
- Register chunking config exposure in `src/bootstrap/treeSitterLanguages.ts` if the language supports chunking

### 2. Runtime Support

- Add the JS fallback grammar dependency and loader wiring
- Add the native runtime grammar dependency and language-id wiring
- Update native supported-language smoke coverage

### 3. Semantic Contract

- Define chunking blocks and split points
- Define graph queries for imports, exports, locals, and import bindings
- Add declaration classification helpers
- Add scope helpers
- Add any narrow language-specific resolution hooks needed for real projects

### 4. Fixtures

- Add a chunking sample in `tests/languages/samples`
- Add a semantic fixture set in `tests/samples/<language>`
- Include both simple and deeper cross-file cases
- Include syntax permutations that are common enough to justify support claims

### 5. Tests

- Add `tests/languages/<language>.test.ts`
- Update `tests/goto.test.ts`
- Update `tests/references.test.ts`
- Update `tests/native-semantic-parity.test.ts` when the language uses the native runtime
- Update native/js parity suites
- Add focused regression tests for language-specific resolution or metadata behavior

### 6. Docs

- Update `docs/language-parity.md`
- Update `docs/scenario-catalog.md`
- Update `README.md` when public support claims change
- Update `codegraph-skill/codegraph/SKILL.md` when examples or supported-surface guidance change

### 7. Honesty Checks

- Do not claim support for dynamic behavior that is only sometimes inferable
- Add explicit limitation notes for intentionally partial cases
- Ensure each support claim has a concrete fixture or regression test behind it

## Recommended Implementation Order

1. Land PHP language definition, registration, fixture scaffolding, and chunking tests
2. Land direct include/require graphing plus local symbol extraction
3. Land `use` import binding support and semantic navigation
4. Land Composer-aware static resolution
5. Land native runtime support and parity hardening if not already enabled in parallel
6. Finalize docs and limitation notes only after tests reflect the true support surface
