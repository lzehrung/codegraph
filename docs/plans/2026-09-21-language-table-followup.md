# Language table follow-up

Planned: 2026-09-21. Baseline: `main` at `ca583ea8`, immediately after PR #373.

PR #373 converted five subsystems from scattered per-language branches to id-keyed tables. This plan
finishes the pattern in the files it did not touch. It is deliberately smaller than #373: no capability
gaps, no new behavior, one subsystem per pull request.

## Why continue

`#373` cut per-language `id === "..."` comparisons in `src/` from 162 to 135, and the remainder is now
concentrated rather than scattered:

| File                                       | Branches | Lines |
| ------------------------------------------ | -------- | ----- |
| `src/util/member-access.ts`                | 17       | 224   |
| `src/indexer/imports/language-specific.ts` | 17       | 615   |
| `src/impact/call-compatibility.ts`         | 14       | 1273  |
| `src/graphs/specifiers.ts`                 | 13       | 535   |
| `src/graphs/edge-resolution.ts`            | 9        | 535   |
| `src/indexer/navigation-goto.ts`           | 8        | -     |
| `src/indexer/locals-and-exports.ts`        | 7        | -     |
| `src/util/resolution.ts`                   | 6        | -     |

Concentration is an improvement over scatter, but these files still carry the defect shape that #373
review rounds kept surfacing: one concept implemented twice, with no test that fails when the copies
disagree. Nine of the eleven Copilot findings on #373 were pre-existing defects of exactly that kind.

## What "the table approach" means here

The pattern #373 established, and the bar each item below must meet:

- Capability data lives in one module keyed by language id, colocated with its subsystem. Precedents:
  `src/util/trivia-tables.ts`, `src/indexer/scope-nodes.ts`, `src/indexer/declaration-visibility.ts`,
  `src/languages/graph-captures.ts`, `src/document-links/html-forms.ts`.
- `LanguageDefinition` stays reserved for hooks that need real per-language code.
- The table has a consistency test that fails when a row is missing, names an unregistered language, or
  declares a node type the pinned grammar does not produce. `tests/scope-node-tables.test.ts` and
  `tests/language-capability-registry.test.ts` are the models.
- Every row that omits a capability carries a one-line reason, and a test asserts the reason exists.
  `src/document-links/html-forms.ts` is the model, and the `<source src>` finding is why: a stale reason
  is worse than none.

## Item 1: member access and receiver shapes

**Files:** `src/util/member-access.ts`, `src/graphs/symbol-graph-detailed/receiver-calls.ts`,
`src/indexer/navigation-goto.ts`.

**Problem.** `member-access.ts` holds 17 branches across five functions that each answer one question per
language: which node type is a member access, which child is the property, and how a qualified name splits.
Kotlin and Swift repeat `navigation_expression` in three places, C and C++ repeat `field_expression`, and Go
repeats `qualified_type`. A sixth question, which identifiers are receiver keywords, already lives in
`RECEIVER_KEYWORDS` in `receiver-calls.ts`, so the concept is split across two files with different shapes.

**Change.** One `src/util/member-access-tables.ts` keyed by language id, with per-language fields for the
member-access node types, the property field name or positional index, the qualified-name node type, and the
receiver keywords, merged from `RECEIVER_KEYWORDS`. The five functions become table lookups.

**Risk.** `getNavigationExpressionProperty` has a Kotlin fallback that is load-bearing and, before #373, had
no consumer coverage. That coverage now exists in `tests/languages/kotlin.test.ts`, `tests/goto.test.ts`,
and `tests/references.test.ts`; do not start this item by changing it.

**Acceptance.** Branch count in `member-access.ts` reaches zero. `tests/receiver-call-edges.test.ts`,
`tests/goto.test.ts`, and `tests/references.test.ts` pass unchanged, with no expectation edits.
A table test asserts every registered source language has a row or is explicitly listed as having no member
access, and that every declared node type exists in that language's pinned grammar.

**Epoch.** `CORE_ALGORITHM_EPOCH` if any resolution output changes; none is intended, so a pure refactor
needs no bump. Say so explicitly rather than bumping defensively.

## Item 2: import binding statement shapes

**Files:** `src/indexer/imports/language-specific.ts`, `src/languages/import-statement-parsers.ts`.

**Problem.** 17 branches in two chains. The first picks a statement parser for C#, Java, Kotlin, Rust, and
PHP; the second maps parsed statements into bindings for Java, C#, Ruby, Go, Rust, Kotlin, Swift, Zig, C, and
C++. Adding a language means editing both chains and remembering the C# `alwaysAliased` special case that
sits 350 lines away from them.

**Change.** One registry entry per language: the parser, the binding mapper, and the flags currently spelled
inline. The dispatch becomes a lookup, matching how `text-import-extractors.ts` already registers reduced-mode
extractors. Consider whether the two registries should be one; they answer the same question for different
runtime modes, and #373 left them separate because only one was in scope.

**Acceptance.** Both chains gone. `tests/languages/*.test.ts` for all ten languages pass with no expectation
edits, and `tests/import-extraction-unicode-identifiers.test.ts` and
`tests/fallback-import-extraction.test.ts` pass unchanged.

**Epoch.** None if binding output is identical. Prove it: index the language fixtures before and after and
diff the serialized bindings, do not rely on tests alone.

## Item 3: split `src/util/specifiers.ts`

**Files:** `src/util/specifiers.ts` (695 lines, grew from 576 in #373).

**Problem.** This file now holds the dynamic-import runner, the shared constant-path fold, and the per-language
call-shape entries for five languages. #373 made the entries cheap to add, which is why the file grew; the
runner and the data should not share a module.

**Change.** Keep the runner and the fold in `specifiers.ts`; move the per-language entries into
`src/util/dynamic-import-tables.ts`. No behavior change.

**Acceptance.** `tests/fallback-import-extraction.test.ts`, `tests/dynamic-resolution.test.ts`,
`tests/fast-graph-edgecases.test.ts`, and the Python, Ruby, and PHP language suites pass unchanged, with byte-
identical output for every existing case.

## Item 4: call-compatibility providers

**Files:** `src/impact/call-compatibility.ts` (1273 lines, 14 branches).

**Problem.** The provider registry was made registry-derived in #373, but arity parsing still branches on
language inside one large file: parameter list shapes, optional and rest markers, and callsite argument
splitting each have their own per-language conditionals.

**Change.** Move the per-language shape data into the provider entries that already exist, so a provider fully
describes its language. This is the largest item and should go last, after items 1 and 2 prove the pattern on
smaller surfaces.

**Acceptance.** `tests/impact-signature.test.ts` (32 cases) and `tests/impact-call-compatibility/**` pass with
no expectation edits.

## Sequencing

1. Item 1 and Item 3 in parallel. Disjoint files, both small, both pure refactors.
2. Item 2 alone. It touches the import path that four #373 findings landed in, so it should not share a window.
3. Item 4 last, once the pattern is proven three times.

One pull request per item. Each states in its description that it is a pure refactor and names the evidence
that output did not change.

## Non-goals

- No new language capabilities. If a table exposes a gap, record it and open a separate issue; #373 grew to
  eleven review rounds partly because capability fixes and consolidation shared a branch.
- No changes to `LanguageDefinition` hook signatures.
- No epoch bumps unless output genuinely changes, and never more than one bump per constant per branch.

## Known gaps this plan does not close

Recorded so they are not rediscovered as surprises:

- C++20 module partitions (`import :part;`, `import foo:part;`) emit no import edge. The pinned grammar exposes
  only the `partition` field and puts the primary name of the qualified form inside an `ERROR` node.
- C++ module implementation units (`module foo;`) are not collected as interface units.
- Rust visibility is a per-file approximation with no crate or module lattice, so a sibling file can resolve a
  `pub(super)` or `pub(in path)` item that rustc would reject.
- Relative C++ partition imports would need `fromFile` threaded into `resolveCppImportPath` at
  `src/util/resolution.ts:216-219`.
