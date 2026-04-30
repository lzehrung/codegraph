# PHP Language Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement PHP as a first-class Codegraph source language with robust source parsing, graphing, symbols, navigation, chunking, Composer-aware static resolution, native/runtime parity, and matching docs.

**Architecture:** Add PHP through the existing shared `LanguageDefinition` and indexing pipeline, then isolate only the PHP-specific pieces at import extraction and resolution seams. Keep native and JS runtime paths aligned by using the same Tree-sitter query model and proving parity through the existing representative/native suites.

**Tech Stack:** TypeScript, Vitest, Tree-sitter JS fallback, Rust `@lzehrung/codegraph-native`, Composer metadata parsing, repo parity docs.

---

### Task 1: Wire PHP Into Discovery, Registration, And Runtime Loading

**Files:**

- Modify: `src/util.ts`
- Modify: `src/languages/all.ts`
- Modify: `src/languages.ts`
- Modify: `src/bootstrap/treeSitterLanguages.ts`
- Modify: `src/chunking/languageConfig.ts`
- Modify: `src/languages/filePrep.ts`
- Modify: `src/cli.ts`
- Modify: `src/jsFallback.ts` only if loader typing/support needs adjustment
- Modify: `packages/codegraph-js-fallback/package.json`
- Modify: `packages/codegraph-native/Cargo.toml`
- Modify: `packages/codegraph-native/src/lib.rs`
- Test: `tests/project-file-discovery.test.ts`
- Test: `tests/chunkFile.behavior.test.ts`
- Test: `tests/native-query-scope.test.ts`
- Test: `tests/package-metadata.test.ts` if runtime package metadata claims change

- [ ] Add failing tests proving PHP source files are discovered by default and chunking config lookup recognizes `php`
- [ ] Run the focused tests and confirm they fail for missing PHP registration
- [ ] Add `.php` to source discovery, register `php` in language support exports, expose `LANG_CONFIGS.php`, and extend CLI language handling where chunking language IDs are validated
- [ ] Add JS fallback dependency wiring for `tree-sitter-php`
- [ ] Add native addon dependency and `supported_language_ids` / smoke-table coverage for `php`
- [ ] Re-run the focused registration/runtime tests and keep them green

### Task 2: Add The PHP Language Definition And Chunking Contract

**Files:**

- Create: `src/languages/definitions/php.ts`
- Test: `tests/languages/php.test.ts`
- Create: `tests/languages/samples/php.sample.php`
- Test: `tests/chunkFile.behavior.test.ts`
- Test: `tests/native-query-normalization.test.ts` only if PHP needs native query normalization

- [ ] Add a failing PHP chunking test that proves class/function/namespace structures are not yet recognized
- [ ] Run the PHP language test and confirm the failure is caused by the missing definition
- [ ] Implement `src/languages/definitions/php.ts` with:
- [ ] file extensions and grammar loader
- [ ] chunk blocks for namespace, class, interface, trait, enum, method, and function forms
- [ ] graph queries for imports, exports, locals, and import bindings
- [ ] declaration/scope helpers and node-type hints for shared navigation
- [ ] Register the definition and add direct structural chunk assertions in `tests/languages/php.test.ts`
- [ ] Re-run PHP chunk tests and keep them green

### Task 3: Implement PHP Graphing, Import Bindings, And Local Symbols

**Files:**

- Modify: `src/graphs.ts`
- Modify: `src/indexer.ts`
- Modify: `src/util.ts`
- Create: `tests/samples/php/*`
- Test: `tests/languages/php.test.ts`
- Test: `tests/native-tree-sitter.test.ts`
- Test: `tests/import-binding-regressions.test.ts` if PHP-specific binding regressions deserve isolated coverage

- [ ] Add failing graph/import-binding tests for `require`, `require_once`, `include`, `include_once`, `use`, grouped `use`, aliases, and namespace-qualified references
- [ ] Run the focused PHP tests and confirm the failures match missing graph/binding behavior
- [ ] Implement static PHP module-specifier extraction and import-binding normalization through the existing shared pipeline
- [ ] Implement local/export symbol extraction for namespaces, classes, interfaces, traits, enums, methods, functions, and top-level constants
- [ ] Keep dynamic include expressions conservative so unresolved behavior stays explicit rather than false-positive
- [ ] Re-run the focused PHP graph/symbol tests and keep them green

### Task 4: Implement Composer-Aware Static Resolution

**Files:**

- Modify: `src/util.ts`
- Modify: `src/graphs.ts`
- Modify: `src/indexer.ts`
- Test: `tests/resolution.test.ts`
- Create or modify: focused Composer/PHP regression tests under `tests/`
- Modify: `tests/languages/php.test.ts`
- Modify: `tests/project-file-discovery.test.ts` only if project-file metadata expectations change

- [ ] Add failing tests for Composer-backed PHP resolution:
- [ ] PSR-4 namespace-to-path mapping
- [ ] PSR-0 mapping when statically deterministic
- [ ] `autoload.files` graph edges
- [ ] `autoload.classmap` file inclusion when explicit/local
- [ ] unresolved dynamic/ambiguous cases staying conservative
- [ ] Run the focused Composer tests and confirm the red state is caused by missing resolution support
- [ ] Implement PHP-aware static resolution helpers that read `composer.json` and integrate with the existing path-resolution flow without special-casing downstream navigation logic
- [ ] Cache and scope Composer metadata sensibly so repo-scale indexing does not repeatedly re-parse the same manifests
- [ ] Re-run Composer/PHP resolution tests and keep them green

### Task 5: Add Shared Semantic Coverage And Runtime Parity

**Files:**

- Modify: `tests/goto.test.ts`
- Modify: `tests/references.test.ts`
- Modify: `tests/native-semantic-parity.test.ts`
- Modify: `tests/native-tree-sitter.test.ts`
- Modify: `tests/native-parser-ownership.test.ts`
- Modify: `tests/detailed-symbol-native-only.test.ts`
- Modify: `tests/languages/parity.test.ts` if PHP belongs in the consolidated parity table
- Modify: `packages/codegraph-native/src/lib.rs`

- [ ] Add failing PHP cases to shared goto and references suites
- [ ] Add failing native-vs-JS PHP parity expectations for graph/specifiers, locals/exports, and end-to-end semantics
- [ ] Add PHP to parser-ownership/native-only suites so native installs prove they do not need the JS fallback package for normal PHP support
- [ ] Run the targeted parity suites and confirm the failures are PHP-specific gaps
- [ ] Implement the remaining runtime parity fixes until PHP behaves like the existing source-language set
- [ ] Re-run the targeted shared/parity suites and keep them green

### Task 6: Update Docs, Scenarios, And The New-Language Checklist

**Files:**

- Modify: `docs/language-parity.md`
- Modify: `docs/scenario-catalog.md`
- Modify: `README.md`
- Modify: `codegraph-skill/codegraph/SKILL.md`
- Modify: `docs/superpowers/specs/2026-04-28-php-language-support-design.md` only if reality forces a documented limitation change

- [ ] Add failing doc-adjacent assertions only where the repo already has enforceable tests for public metadata or examples
- [ ] Update PHP entries in the language parity matrix and project file coverage
- [ ] Add scenario-catalog entries for every PHP syntax/resolution shape claimed by the implementation
- [ ] Update README and skill docs if supported-language lists, examples, or installation/runtime claims changed
- [ ] Confirm doc claims match the real tests and fixture set, not intended behavior

### Task 7: Final Verification

**Files:**

- Verify all changed files above

- [ ] Run targeted focused suites for PHP language, Composer resolution, shared goto/refs, native parity, and docs-sensitive metadata
- [ ] Run broader repo verification appropriate to the change set:
- [ ] `npm run test:ci -- tests/languages/php.test.ts tests/goto.test.ts tests/references.test.ts tests/native-semantic-parity.test.ts tests/native-tree-sitter.test.ts tests/native-parser-ownership.test.ts tests/detailed-symbol-native-only.test.ts tests/project-file-discovery.test.ts tests/resolution.test.ts`
- [ ] `npm run test:native`
- [ ] `npm run build`
- [ ] If failures appear outside PHP scope, fix real regressions rather than weakening tests
- [ ] Review `git diff --stat` and ensure docs, scenarios, runtime wiring, and tests all landed together
