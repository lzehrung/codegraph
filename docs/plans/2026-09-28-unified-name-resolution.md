# Plan: unified resolution for navigation, references, and call graphs

Status: implemented on branch `refactor/unified-resolution` (PR #392); in review. Revised 2026-10-01 after a code
audit of `main` at 2.4.0 (`ed1b0ba2`).

## Goal

Every consumer (go-to-definition, references, the detailed call graph, impact) gets the same
answer for the same use, because each decision exists in one place:

- which languages resolve imports through declarations, and how a specifier maps to files;
- what a callable is (its identity) and which overloads are the same callable;
- which member a receiver call names;
- which declaration a bare name names (done in PR #385).

New language rules then go in one place, and a test matrix finds disagreements before review.

## Audit findings (2026-10-01)

The first version of this plan targeted bare-name lookup. PR #385 already moved bare-name
lookup into `src/indexer/name-resolution.ts` and per-language policies in
`src/indexer/name-lookup-policies/`. The graph's `resolveIdentifier` is now a thin wrapper over
`resolveBareName` (`src/graphs/symbol-graph-detailed.ts:502-505`). The remaining problems are
elsewhere:

- **Member and receiver resolution is duplicated.** It is most of the resolution code:
  about 2,400 of 3,318 lines in `navigation-goto.ts`, 1,300 of 1,900 in `receiver-calls.ts`, and
  950 of 1,708 in `edge-passes.ts`. Shared today: receiver proof
  (`receiverConstructorExpression`), syntax tables, and C#/Swift owner identity. Not shared:
  owner lookup, the base and member walk, arity selection, and visibility.
- **The graph has three member-call paths.** Receiver calls go to the graph's own deferred
  resolver (`receiver-calls.ts`). C# dotted receivers and Java/C# qualified construction go to
  navigation's `resolveMemberAccessDefinition` (`edge-passes.ts:1345-1362`). Member chains go to
  `member-chains.ts`.
- **The graph still has its own bare-name precedence.** `hasNonModuleBinding` and the Swift/C#
  implicit-owner check in `edge-passes.ts:949` and `:1187-1201` decide lookup outside the core.
- **Callable identity has no single form.** Arity is already shared
  (`src/languages/callable-arity.ts`, also used by impact). Identity is not: `SymbolDef` ranges,
  scope `Binding` collision chains, `CppCallableShape` (`cpp-callables.ts`), TypeScript overload
  groups (`ts-callables.ts`), and graph node aliases each decide which declarations are one
  callable. Most C++ code is identity work: about 550 of 590 lines in `cpp-callables.ts`.
- **Declaration-resolved languages are listed in four places.**
  `DECLARATION_RESOLVED_IMPORT_LANGUAGES` (`build-index.ts`),
  `EXTERNAL_SPECIFIER_RESOLUTION_RULES` (`incremental-plan.ts`), `IMPLICIT_UNIT_LANGUAGES`
  (`compilation-units.ts`), and the resolver dispatch in `util/resolution.ts` and
  `graphs/edge-resolution.ts`. PR #391 needed many review rounds because each list had to be
  found by hand.
- **Specifier-to-file resolution is dispatched twice.** File-graph edges
  (`graphs/edge-resolution.ts:127-198`) and import bindings (`indexer/imports.ts`,
  `indexer/imports/import-binding-tables.ts`) share low-level resolvers but repeat the language
  dispatch and the C# filters. Issue #388 and PR #390 came from this split.
- **Scope construction also decides lookup.** `scope.ts`, `scope-nodes.ts`,
  `star-import-precedence.ts`, and `declaration-visibility.ts` decide hoisting, shadowing,
  class-body boundaries, and import precedence. Most recent Python fixes were here.
- **Tests find disagreements only after the fact.** The parity corpus is 52 hand-picked
  directories that compare go-to-definition with graph edges. It is not a language by
  call-form matrix, and many cells are empty (PHP almost entirely; Python receivers and
  overloads; C++ construction and inheritance; Java bare and inherited calls). No test compares a
  warm build with a cold build across file changes, which is the defect class of PR #391.
  `docs/language-parity.md` is written by hand.
- **Per-index caches are scattered.** 23 `WeakMap<ProjectIndex>` caches in 11 files.

## Design

### Step 1: call-form matrix and metamorphic checks

A table-driven test matrix. Each cell is one language and one call form, with:

- the files of a small project;
- the use site and the expected declaration, or `not_found`;
- a decoy: a same-named declaration that must not be the answer.

For each cell the harness checks:

- go-to-definition returns the expected declaration;
- references of the declaration include the use and exclude the decoy;
- the detailed graph has the call or construction edge for call forms, and no edge to the decoy.

Metamorphic checks on every cell:

- adding an unrelated same-named decoy file does not change any answer;
- a warm disk-cache build equals a cold build after each change: add a decoy, delete a decoy,
  rewrite a declaring file, and rename a declaring file;
- where a cell gives a moved variant, moving the declaration keeps the answer on the moved
  declaration.

The harness writes a call-form coverage report. `docs/language-parity.md` links to it.

Call forms: bare call, qualified or namespace call, `this`/`self` member call, typed-local
receiver, static or type receiver, construction, imported or aliased name, overload by argument
count, inherited member, and `super`/`base` call. Languages: every language with semantic
navigation. A cell that a language cannot express is omitted, not marked as passing. A known
gap is marked with its reason and stays visible in the report.

### Step 2: one language-capability registry and one specifier resolver

- Put the resolution capabilities in one table keyed by language id, next to import resolution:
  whether imports resolve through declarations, the implicit compilation-unit kind (package,
  namespace, module), and the external-specifier re-resolution rule.
- Derive `DECLARATION_RESOLVED_IMPORT_LANGUAGES`, the external-specifier rule, and
  `IMPLICIT_UNIT_LANGUAGES` from the table. Delete the hand-written lists.
- One function maps an import specifier to target files for a language. Import bindings and
  file-graph edges both call it. The C# rule that a `using` directive never names another
  language's file exists once.
- Where the two callers disagree today, pick one rule, with a test that fails before.

### Step 3: canonical callable identity

- At index time, each callable `SymbolDef` gets an identity: a key that equal declarations
  share (C++ prototype and definition, normalized signature, owner path), its owner, and its
  arity range from `callable-arity.ts`.
- C++ equivalent-declaration grouping, TypeScript overload groups, graph node aliases, and
  impact caller grouping read this identity. They stop deriving it again.
- The cached module format changes, so bump `CORE_ALGORITHM_EPOCH`, the parsed-cache version,
  and the snapshot version, and validate the new field on load.
- Results do not change, except documented bug fixes with a failing-first test.

### Step 4: one member and receiver resolver

- **4a. Member selection.** One function selects the member a call names, given an owner, a
  name, the argument count, and the static or instance scope. It walks the owner then its bases
  in order, stops at the first owner that declares the name (hiding), applies visibility, and
  filters by arity. Navigation and the graph call it through a small owner model (owner, bases,
  members, visibility). Navigation builds the model from the index; the graph builds it from
  its ownership and inheritance edges.
- **4b. Receiver classification.** One function maps a receiver expression to a proof:
  `this`/`self`/`super`, a declared type, a constructor, a static type, a module or namespace,
  or unknown. Navigation and the graph both use it.
- **4c. Graph-only lookup.** Move the Swift/C# implicit-owner precedence and
  `hasNonModuleBinding` from `edge-passes.ts` into the lookup policies.
- The arity rule stays explicit per consumer: navigation keeps the only candidate when the
  argument count does not fit, so callers of a changed signature stay visible; the graph records
  no edge.

## Progress

- [x] Audit `main` and revise this plan.
- [x] Record baselines (`ed1b0ba2`, median of 3, `cache: "off"`):
  - `npm run test:fast`: 5,542 passed, 19 skipped, 336 files.
  - `src/`: index 2,274 ms, detailed graph 3,862 ms, 27,436 edges.
  - `tests/samples`: index 4,980 ms, detailed graph 2,936 ms, 1,026 edges.
  - `tests/samples/cpp`: first build 1,612 ms, second build 537 ms.
- [x] Step 1: matrix harness and cell table (`tests/call-form-matrix/`).
- [x] Step 1: 127 cells across 15 languages; a form a language cannot express is omitted with a reason.
- [x] Step 1: metamorphic checks (unrelated decoy file, warm versus cold build, moved declaration).
- [x] Step 1: generated report `docs/coverage/call-forms.md`, linked from `docs/language-parity.md`.
- [x] Step 1: the matrix found 29 gaps; all are fixed, each with a test in its language suite.
- [x] Step 2: capabilities in one table, `src/indexer/import-resolution-tables.ts` (a subsystem
      table, as `docs/adding-language-support.md` requires, not `LanguageDefinition` fields).
- [x] Step 2: one specifier-to-files resolver, `src/util/resolution/specifier-targets.ts`, for
      bindings and graph edges. Six C#, Ruby, Python, Rust, and SCSS divergences now agree.
- [x] Step 3: `SymbolDef.callable`, computed at index time (`src/indexer/callable-identity.ts`),
      cached and validated (epoch 77, parsed cache 7, snapshot 12).
- [x] Step 3: C++, TypeScript, graph aliases, scope bindings, and impact read the identity.
- [x] Step 4a: `src/indexer/member-selection.ts` with navigation and graph owner models.
- [x] Step 4b: one receiver classifier (`classifyReceiver`) for navigation and the graph.
- [x] Step 4c: graph-only bare-name precedence moved into lookup policies; `hasNonModuleBinding`
      is gone.
- [x] Docs: `how-it-works.md`, `adding-language-support.md`, `language-parity.md`,
      `AGENTS.md`, and the changelog.
- [x] Gate: typecheck, lint, format, build, native tests, coverage run (6,194 passed), fixture
      cleanliness. `security:production` fails on a new `piscina` advisory that also affects
      `main`; the fix is a separate dependency change.
- [x] Review: two review-and-correct rounds, then Copilot review rounds on PR #392.

## Results

- Places that list declaration-resolved languages: 4 to 1 table.
- Specifier-to-file dispatch implementations: 2 to 1.
- Callable identity forms: 5 to 1. C and C++ cross-file folding through includes and
  `using` declarations stays a query-time fact, because it needs other files.
- Member-selection implementations: 2 to 1. Module and namespace export chains
  (`member-chains.ts`) stay separate: they are not class membership.
- Detailed graph on the 2.4.0 `src/` tree: 3,675 ms on 2.4.0, 3,148 ms on this branch (median of
  5), same 27,436 edges. Index time: 1,930 ms and 1,992 ms. `tests/samples`: same graph time
  and the same 1,026 edges.
- Source size grew: `src/` has 2,693 lines added and 1,282 removed. The removed duplication is
  smaller than the code for the 29 gap fixes. The first version of this plan expected a net
  decrease; that target is not met.

## Rules for every step

- Each step keeps every existing test green without changing expectations. A bug fix found on
  the way gets its own commit and a test that fails before the fix.
- Inclusion and exclusion are tested together: the expected answer and a same-named decoy.
- Build `dist` before worker-pool tests (`AGENTS.md`).
- Performance: compare with the baseline. Watch tree-sitter query compile time; enumerated
  patterns tripled C++ compile time in PR #384.
- Never swap source files for before and after proofs while a background `npm run check` runs.

## Metrics

- Places that list declaration-resolved languages: 4 to 1.
- Specifier-to-file dispatch implementations: 2 to 1.
- Callable identity forms: 5 to 1.
- Member-selection implementations: 2 to 1. Graph member-call paths: 3 to 1.
- Matrix cells covered per language and call form, reported by the harness.
- Graph build time and first-build time within 5% of the baseline.

## Out of scope

- Expression type inference, overload ranking by type, generics, macros, and reflection
  (`AGENTS.md`, "Semantic Accuracy Bar").
- Rewriting `buildScopeIndexFromSource` and `collectLocalsAndExportsFromSource`. They decide
  lexical visibility, so the matrix covers them, but this plan does not restructure them.
- Consolidating the 23 per-index caches behind one cache object. It is worth doing, but it
  does not change answers. Do it after step 4.
- Impact in the matrix. Impact needs git ranges, so step 3 tests impact caller grouping in its
  own suite.
