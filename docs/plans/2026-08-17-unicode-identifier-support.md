# Unicode identifier support (2026-08-17)

Status: Planned. Supersedes the separate normalization and end-to-end fixture plans; no code in this plan has landed.

## Problem

PR #262 widened identifier _grammars_ so extraction accepts each language's real identifier syntax (`src/util/identifiers.ts`). Grammar breadth is only the first of four layers, and the other three still assume ASCII or raw-text equality:

1. **Grammar** - which characters may appear in an identifier. Done for import/alias extraction.
2. **Equality** - when two different spellings name the same symbol. Not implemented anywhere.
3. **Scanning** - the fallback regex scanners that find identifiers when no parse tree is available. Still ASCII-only in 15+ places.
4. **Evidence** - cross-file fixtures proving a Unicode name survives parse, graph, and navigation. Only Python has them.

### Layer 2: equality is unimplemented

Four languages define two spellings as the same identifier for name resolution. codegraph compares raw captured text everywhere, so those spellings resolve as different symbols.

| Language | Spec rule                                                    | Example equal pair               |
| -------- | ------------------------------------------------------------ | -------------------------------- |
| Python   | PEP 3131: compare after NFKC                                 | `café` (U+00E9) and `cafe\u0301` |
| Rust     | `rustc` normalizes identifiers to NFC                        | same NFC/NFD pair                |
| Java     | JLS 3.8: ignore `Character.isIdentifierIgnorable` characters | `Foo` and `Foo\u200C`            |
| C#       | ECMA-334: drop leading `@`, then drop `Cf`                   | `@Widget` and `Widget`           |

Kotlin, Go, PHP, and JS/TS have no such rule; their compilers compare code points directly. Those languages must keep raw comparison, so a global normalization pass would be wrong.

### Layer 3: scanners silently drop non-ASCII identifiers

Confirmed ASCII-only identifier classes outside the extraction path. Each silently omits evidence rather than failing:

- `src/util/bloomFilter.ts:175` - reference candidate prefilter. A non-ASCII name is never added, so `findReferences` prunes the file before verification.
- `src/duplicate-token-normalization.ts:3-5` and `packages/codegraph-native/src/duplicate_tokens.rs:81-87` - duplicate fingerprints. `café` tokenizes as `caf` + `é`, so the identifier text leaks into the fingerprint that exists to be rename-insensitive, and native and JS tokenizers must stay in lockstep.
- `src/indexer/locals-and-exports.ts:84-92,824,892-939` - regex fallback export extraction for JS-like sources.
- `src/util/resolution/jvm.ts:49-57` and `src/util/resolution/php.ts:409-411` - symbol index scanners used for cross-file resolution.
- `src/review/summaries.ts:77-92,141-143`, `src/indexer/navigation-references.ts:57-76`, `src/impact/report-suggestions.ts:635-640`, `src/frameworks/angularjs.ts:38-45`, `src/util/rustTestModules.ts:43`, `src/indexer/navigation-goto.ts:298,440,493,498`, `src/indexer/navigation-resolve.ts:129,170-171`, `src/indexer/imports/languageSpecific.ts:465`.

## Design

### The seam already exists

`LanguageSupport.normalizeIdentifier(name: string): string` is declared at `src/languages/types.ts:80`, adapted at `src/languages.ts:35`, and defaults to identity at `src/languages.ts:55`. PHP already uses it to strip a leading `$` (`src/languages/definitions/php.ts:122`) - structurally the same operation C# needs for `@`.

Reusing it is the elegant path because it is already per-language, already opt-in, already consumed by scope construction (`src/indexer/scope.ts:43-45,100,110,162,412`) and member lookup (`src/indexer/navigation-goto.ts:158,568-577`), and already part of the build-cache implementation fingerprint (`src/indexer/build-cache/options.ts:51,75,104,132`), so changing a rule invalidates stale caches automatically.

No new global switch statement is introduced. Each rule lives beside the grammar it belongs to, in that language's definition file.

### Comparison-only, never storage

Identifier text is embedded in persisted and user-visible identities:

- `defNodeId` -> `${file}::${localName}::${index}` (`src/graphs/symbol-graph.ts:69-73`)
- `symbolIdentifier` -> `${localName}::${kind}::${startIndex}` (`src/util/symbolHash.ts:54-56`)
- portable handles -> `symbol:<file>:<name>:<line>:<column>` (`src/agent/handles.ts:23-30`)
- SQLite `symbols.id`/`symbols.name` (`src/sqlite/schema.ts:208-219`, `src/sqlite/write.ts:99-110`)
- artifact `graph.json` ids and names (`src/agent/artifact.ts:441-521`)
- disk module cache and snapshot payloads (`src/indexer/build-cache/module-cache.ts:426-474`, `src/indexer/build-cache/project-snapshot.ts:679-696`)
- review and duplicate handles (`src/review/summaries.ts:54-62,465-467`, `src/duplicates/units.ts:131-158`)

Canonicalization therefore applies to lookup keys and comparisons only. Stored names, ranges, rename edit text, and handles keep the exact source spelling.

### Language signal

`SymbolDef` and `ModuleIndex` carry no language (`src/indexer/types.ts:29-38,65-70`), so canonicalization derives it from the file with `supportForFile(file, index.languageExtensions)` (`src/languages.ts:136`). The rule is: **the file that owns the declaration decides identifier equality**, matching how a compiler resolves names.

### Cost control

Canonicalization must not add per-comparison Unicode work to ASCII repositories:

- Languages without a rule keep the identity default and pay nothing.
- Rules start with a single scan rejecting any code point above U+007F (plus C0 controls for Java) and return the input unchanged when it matches. NFC, NFKC, and formatting-character removal are all no-ops on that input.
- Per-file lookup maps are built once and memoized where they already are (`src/indexer/navigation-resolve.ts:53-81`); a bounded `src/util/lruMap.ts` cache keyed by language and name absorbs repeated canonicalization of hot names.

## Phases

Each phase is a self-contained PR and leaves the tree green.

### Phase 1 - make the existing seam consistent

Prerequisite bug fix; today it is masked because only PHP uses the hook.

- `src/indexer/scope.ts:52-77` inserts import aliases into the root scope with raw keys while declarations at `scope.ts:44-45` are normalized, and `src/indexer/navigation.ts:396` queries with a raw `imp.local`. Route all import-alias inserts and queries through `normalizeIdentifier`.
- Split display from identity: keep `Binding.name` as the source spelling and add an explicit canonical key used by the scope maps (`src/indexer/scope-types.ts:18-31`). Consumers that display names (`src/indexer/workspace-symbols.ts:188-193`) must read the raw field, which also removes today's PHP `$`-stripped display quirk.
- Regression: a PHP `use ... as` alias and a declaration of the same name resolve to one binding.

### Phase 2 - per-language equality rules

- Export the Java identifier-ignorable set and the C# `Cf` set from `src/util/identifiers.ts` so the grammar constants and the equality rules consume one definition and cannot drift.
- Implement `normalizeIdentifier` in `src/languages/definitions/python.ts` (NFKC), `rust.ts` (NFC), `java.ts` (drop identifier-ignorable), and `csharp.ts` (drop leading `@`, then drop `Cf`), each with the ASCII fast path.
- Leave every other definition on the identity default so adding a language never opts in silently.
- Regression: each rule collapses its documented pair, and Kotlin, Go, PHP, and JS/TS keep the two spellings distinct.

### Phase 3 - cross-file resolution keys

Scope-local resolution is covered by phases 1 and 2; cross-file resolution is not.

- `moduleNameLookup` (`src/indexer/navigation-resolve.ts:53-81`) already memoizes per file. Resolve `supportForFile` once in that memo entry and key `localExports`, `namespaceReexports`, `reexports`, and `locals` by canonical name; canonicalize each query with the same support.
- Canonicalize the name component of the export cache and cycle keys (`navigation-resolve.ts:16-17,282-352`) and of the reference candidate cache key (`src/indexer/navigation-references.ts:263-267`).
- Canonicalize definition identity comparators `sameSymbolDef` (`navigation-resolve.ts:86-88`) and `sameDef` (`src/indexer/reference-context.ts:8-15`); leaving them raw would make phase-3 map hits fail verification.
- Canonicalize both sides of the exact reference scan (`src/indexer/navigation-references.ts:166`) using the candidate file's support.
- Build and probe bloom filters through the same canonical form (`src/util/bloomFilter.ts:175`, `src/indexer/navigation.ts:289-304,434-438`). Symmetry is required: a canonical probe against a raw-text filter would prune valid candidates.
- Preserve ambiguity: canonical keys can collide where raw keys did not, so first-hit paths (`navigation-resolve.ts:148`, namespace fallbacks) must keep reporting ambiguity rather than silently selecting one definition.
- Out of scope: package identifiers and Python submodule filenames (`navigation-resolve.ts:146,206-251`) are filesystem and module-path strings and stay raw.

### Phase 4 - Unicode-aware scanners

Ordered by evidence loss, not by file count.

1. `src/util/bloomFilter.ts:175` - lands with phase 3 because reference recall depends on it.
2. Duplicate tokenizers - `src/duplicate-token-normalization.ts:3-5` and `packages/codegraph-native/src/duplicate_tokens.rs:81-87` must change together and bump `DUPLICATE_TOKENIZER_REVISION` (`src/duplicates/unitCache.ts:38`). `tests/duplicates.test.ts` covers the JS tokenizer and `preserves_keyword_tokens_like_js_fallback` in `packages/codegraph-native/src/duplicate_tokens.rs` mirrors it from the Rust side, so both suites must move together.
3. Fallback export and resolution scanners - `src/indexer/locals-and-exports.ts:84-92,824,892-939`, `src/util/resolution/jvm.ts:49-57`, `src/util/resolution/php.ts:409-411`.
4. Report and review text scanners - `src/review/summaries.ts:77-92,141-143`, `src/indexer/navigation-references.ts:57-76`, `src/impact/report-suggestions.ts:635-640`, `src/frameworks/angularjs.ts:38-45`, `src/util/rustTestModules.ts:43`, `src/indexer/navigation-goto.ts:298,440,493,498`, `src/indexer/navigation-resolve.ts:129,170-171`, `src/indexer/imports/languageSpecific.ts:465`.

Each site consumes the shared constant for its language instead of a hand-rolled class. Regexes that match non-identifier text (paths, URLs, SQL, keywords, markup) are explicitly out of scope.

### Phase 5 - end-to-end fixtures and documentation

Parser-level unit coverage exists in `tests/import-extraction-unicode-identifiers.test.ts`, but only Python has cross-file fixtures (`tests/samples/python/.regressions/unicode_*.py`). Per `AGENTS.md`, a cross-file language scenario needs the language test plus the shared semantic suites.

| Language | Sample directory                     | Case                                                                    |
| -------- | ------------------------------------ | ----------------------------------------------------------------------- |
| Java     | `tests/samples/java/.regressions/`   | combining-mark class name and import                                    |
| Kotlin   | `tests/samples/kotlin/.regressions/` | Unicode `import ... as` alias                                           |
| C#       | `tests/samples/csharp/.regressions/` | `using alias = Namespace;` with combining mark, plus `@`-verbatim alias |
| Go       | `tests/samples/go/.regressions/`     | Unicode-letter import alias                                             |
| PHP      | `tests/samples/php/.regressions/`    | non-`\p{L}` `use ... as` alias                                          |
| Rust     | `tests/samples/rust/.regressions/`   | `use ... as` alias with XID continuation                                |

Per language: add the two-file fixture, then extend `tests/languages/<language>.test.ts` (dependency edge), `tests/goto.test.ts`, `tests/references.test.ts`, and `tests/native-semantic-parity.test.ts`, and add a `docs/scenario-catalog.md` row. Add equality fixtures for Python, Rust, Java, and C# where declaration and consumer use different-but-equal spellings, and negative fixtures proving Kotlin, Go, PHP, and JS/TS do not collapse.

Documentation updates in the same change:

- `docs/language-parity.md:95` currently claims real-grammar coverage generally; narrow it to extraction and add which languages canonicalize for resolution.
- `docs/scenario-catalog.md:94,117,177,189,200,216,235,255` point at parser-level tests only; add the cross-file rows.

## Progress

Checked items are implemented and covered by their named regression. Update this list in the same commit that lands the work.

### Phase 1 - existing seam consistency

- [ ] Route import-alias scope inserts and queries through `normalizeIdentifier`
- [ ] Split raw display name from canonical scope key in `Binding`
- [ ] Regression: PHP alias and same-named declaration resolve to one binding

### Phase 2 - per-language equality rules

- [ ] Export shared Java identifier-ignorable and C# `Cf` sets from `src/util/identifiers.ts`
- [ ] Python `normalizeIdentifier` (NFKC) with ASCII fast path
- [ ] Rust `normalizeIdentifier` (NFC) with ASCII fast path
- [ ] Java `normalizeIdentifier` (drop identifier-ignorable) with ASCII fast path
- [ ] C# `normalizeIdentifier` (drop leading `@`, then `Cf`) with ASCII fast path
- [ ] Regression: each rule collapses its pair; Kotlin, Go, PHP, JS/TS stay distinct

### Phase 3 - cross-file resolution keys

- [ ] Canonical keys in `moduleNameLookup` build and query paths
- [ ] Canonical name component in export cache, cycle, and reference-candidate cache keys
- [ ] Canonical `sameSymbolDef` and `sameDef` comparators
- [ ] Canonical exact reference scan
- [ ] Canonical bloom filter build and probe
- [ ] Ambiguity preserved where canonical keys newly collide

### Phase 4 - Unicode-aware scanners

- [ ] `src/util/bloomFilter.ts` identifier tokenization
- [ ] Duplicate tokenizers (JS and Rust) plus `DUPLICATE_TOKENIZER_REVISION` bump
- [ ] Fallback export and resolution scanners
- [ ] Report and review text scanners

### Phase 5 - fixtures and documentation

- [ ] Java cross-file fixture and suites
- [ ] Kotlin cross-file fixture and suites
- [ ] C# cross-file fixture and suites
- [ ] Go cross-file fixture and suites
- [ ] PHP cross-file fixture and suites
- [ ] Rust cross-file fixture and suites
- [ ] Equality fixtures for Python, Rust, Java, C#
- [ ] Negative fixtures for Kotlin, Go, PHP, JS/TS
- [ ] `docs/language-parity.md` and `docs/scenario-catalog.md` updates

## Verification

- Per phase: the named regressions plus `npx vitest run` on the touched suites.
- Phase 3 and 4: confirm each new case fails with the phase reverted, so the fixture exercises the fixed path rather than an already-passing ASCII case.
- Phase 4 item 2: `npm run test:native` for the Rust tokenizer and its JS parity assertion.
- Full `npm run check` before each PR merges.

## Non-goals

- No change to stored or displayed identifier text, portable handles, symbol ids, SQLite rows, or rename edit content.
- No canonicalization for languages without a documented spec rule, even where the grammar was widened.
- No case folding as identity; workspace search ranking (`src/indexer/workspace-symbols.ts:223-247`) stays a separate ranking concern.
- No new language support.
