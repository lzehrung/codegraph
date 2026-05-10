# Refactor Operations + Trivia-Aware Symbol Ranges

> Plan to (a) optionally include leading doc-comment trivia (JSDoc, C# `///`,
> Python docstrings, Rust `///`/`//!`, Java `/** */`, Go `//`, etc.) and
> decorators/attributes when computing a symbol's `range`, and (b) build a
> `refactor` feature surface (rename / move / extract) that agents can drive
> by pointing at a symbol handle.

## Background

- `SymbolDef.range` currently uses the bare tree-sitter node range
  (`src/util/ast.ts:24-43`, `toRange`). Leading comments and decorators sit
  in **trivia** — siblings before the node — and are excluded.
- Doc-comment **text** is already captured into `SymbolDef.docstring`
  (`src/indexer/locals-and-exports.ts:200-234`), but the range is not
  expanded to cover those lines, so consumers cannot reliably "select the
  whole declaration including its docs" using `range.start.line:range.end.line`.
- Codegraph already has the primitives a refactor surface needs:
  `findReferences` / `findReferencesById` (`src/indexer/navigation.ts:161`,
  `src/indexer/symbols.ts:102`), `goToDefinition*`, `resolveSymbolId`,
  `ProjectIndex`, exports/imports tables. There is no rename/move/extract
  surface yet (`src/agent-tools.ts`, `src/index.ts`).
- The library is multi-language via tree-sitter (`src/languages/definitions/*.ts`),
  with both a native runtime path and a JS-fallback path. Behaviour parity
  across languages is a hard project rule (`AGENTS.md`).

## Goals

1. **Trivia-aware range option** — caller can ask for ranges that include
   the leading doc-comment block (and optionally decorators/attributes).
2. **`refactor` API surface** — three operations (`rename`, `move`,
   `extract`) returning structured edits the agent applies. No filesystem
   writes from the library by default; provide a small `applyEdits`
   helper that writes them.
3. **CLI + agent-tools wrappers** so the existing agent skill
   (`codegraph-skill/codegraph/SKILL.md`) gains `codegraph refactor …` /
   `tool_refactor*` commands.
4. **Cross-language parity** for what is in scope. Where a language can't
   support an operation safely, return a structured `unsupported` result —
   never a silent partial.

## Non-Goals (explicitly)

- Full LSP-equivalent semantic rename for languages requiring full type
  resolution (e.g. cross-package C# overload sets). We rely on the existing
  reference resolver — same fidelity as `findReferences`.
- Cross-repository moves.
- Reformatting / pretty-printing after edits — we only emit minimal
  text edits.
- Code generation for new method signatures during `extract`. v1 extracts
  a contiguous region into a new top-level function in the same file
  (and optionally a new file via `move`).

## Architecture: Stale Index, Fresh Tree

**Contract every phase inherits.**

`ProjectIndex` is the **discovery oracle**: which symbols exist, who
exports/imports/references whom, scope chains. Structural. Cheap to
reuse across many refactor calls.

`ProjectIndex` is **not** the position oracle. The cached
`SymbolDef.range` snapshots byte offsets at the moment the index was
built. The first edit any refactor emits invalidates those offsets for
every file it touches. Chained ops (move then rename, or two renames)
compound the drift.

**Position truth comes from a live tree-sitter parse of the file at the
moment of edit emission**, not from anything cached.

```
1. ProjectIndex.findReferences(handle) → list of (file, name) tuples   [cached, OK]
2. For each touched file, read disk + parse → fresh tree               [authoritative]
3. Compute trivia ranges, name-token ranges, edit offsets              [from fresh tree]
4. Emit TextEdits using fresh-tree byte offsets                        [authoritative]
5. applyEdits writes atomically with EOL preservation                  [unchanged]
6. Chained refactor? Re-parse touched files again before next op.
   ProjectIndex is never mutated mid-batch — discard or rebuild after.
```

Why this works:

- Tree-sitter parses ~50k LOC/sec — re-parsing one file per edit
  emission is invisible. Re-indexing the whole project would not be.
- Discovery info is structural and survives most edits ("file X
  exports `foo`" stays true after renaming an internal helper).
  Recomputing it on every refactor call would waste budget.
- Idempotence becomes free: the second `refactor*` call against
  post-edit disk reparses, sees no work to do, returns
  `edits.length === 0`.

Per-call memos (e.g. "parsed `foo.ts` once during this `move` call") are
fine and encouraged. **Persistent per-`ProjectIndex` tree caches are
not** — they encode stale offsets the moment any edit lands.

## Architecture Overview

```
                    ┌─────────────────────────────────────┐
                    │   ProjectIndex (existing)           │
                    │   — locals, exports, imports        │
                    │   — SymbolDef.range (bare)          │
                    │   — SymbolDef.docstring (text only) │
                    └──────────────┬──────────────────────┘
                                   │
        ┌──────────────────────────┼─────────────────────────────┐
        │                          │                             │
        ▼                          ▼                             ▼
 ┌──────────────┐         ┌──────────────────┐         ┌──────────────────┐
 │ trivia.ts    │         │ refactor/rename  │         │ refactor/move    │
 │ — leading    │◄────────┤ — uses           │         │ — uses trivia.ts │
 │   doc range  │         │   findReferences │         │ — uses imports   │
 │ — decorators │         │ — emits edits    │         │   table          │
 │ — comments   │         │                  │         │ — emits edits    │
 └──────────────┘         └──────────────────┘         └──────────────────┘
                                                                  │
                                                                  ▼
                                                         ┌──────────────────┐
                                                         │ refactor/extract │
                                                         │ — region-scoped  │
                                                         │ — reuses trivia  │
                                                         │   + rename       │
                                                         │   primitives     │
                                                         └──────────────────┘
                                                                  │
                                                                  ▼
                                                         ┌──────────────────┐
                                                         │ Edit[]           │
                                                         │ + applyEdits()   │
                                                         └──────────────────┘
```

## Shared Types (introduced in Phase 0)

```ts
// src/refactor/types.ts
export type TriviaMode =
  | "exclude"          // current behaviour
  | "leading-doc"      // include /** */ /// // # leading comment block
  | "leading-all";     // doc + decorators / attributes / annotations

export interface SymbolRangeOptions {
  trivia?: TriviaMode; // default "exclude"
}

export interface TextEdit {
  file: FileId;
  /** Authoritative byte offsets into the source the edit was computed against. */
  start: number;
  end: number;
  /** Replacement text; empty string means deletion. Always emitted with `\n`
   *  line endings — `applyEdits` rewrites to the file's detected EOL on write. */
  newText: string;
  /** Optional human-friendly display range for diff / log output. */
  display?: Range;
}

export interface RefactorResult {
  status: "ok" | "unsupported" | "error";
  edits: TextEdit[];
  warnings: string[];
  /** Populated when status !== "ok". */
  reason?: string;
}
```

`Range` reuses `src/types.ts` so existing tooling renders with no changes.

---

# Phase 0 — Foundations

**Goal:** wire shared infrastructure used by every later phase. No user-
visible feature yet.

### Tasks

- [ ] Create `src/refactor/types.ts` with `TriviaMode`,
      `SymbolRangeOptions`, `TextEdit`, `RefactorResult`.
- [ ] Re-export the new types from `src/index.ts` under the existing
      "Project indexing…" block (keep alphabetical order).
- [ ] Add `applyEdits(edits: TextEdit[], opts?: { dryRun?: boolean; useGit?: boolean }):
      Promise<{ writes: string[]; conflicts: string[]; skipped: string[] }>`
      in `src/refactor/applyEdits.ts`.
  - **Partition** by file. Cross-file edits are independent; conflict
    detection is per file.
  - **Per file:** sort by descending `start`. If any pair `[a,b]` has
    `a.start < b.end`, record a conflict and skip the *whole file*'s
    edits (don't half-apply).
  - **Atomic write:** write each file via temp file + rename
    (`fs.writeFile` to `<path>.<rand>.tmp` then `fs.rename`). Buffer the
    post-edit string in memory before any disk write so a mid-batch
    failure leaves prior files untouched.
  - **EOL preservation:** detect file's existing line ending (first
    `\r\n` occurrence wins, default `\n`). Replace `\n` in `newText`
    with the detected EOL on write only — internal edit math stays on
    `\n`.
  - **Binary / non-UTF-8 guard:** if the source file fails UTF-8 decode,
    emit a `skipped` entry and continue.
  - **`useGit`:** for newly-created files, shell out to
    `git mv` / `git add` so blame history follows. Off by default.
- [ ] Unit tests:
  - `tests/refactor/applyEdits.test.ts`
    - Multi-edit single-file ordering
    - Overlap detection
    - `dryRun` returns the post-edit text without writing
    - CRLF preservation (Windows line endings — matters here, see
      `_sourceLines` handling in `locals-and-exports.ts:198`)

### Rationale

Locks down the edit shape before any caller emits one. Sorting by
descending start index is the standard way to make sequential string
edits commute on a single buffer.

---

# Phase 1 — Trivia-Aware Symbol Ranges

**Goal:** callers can request that `SymbolDef.range` (or a derived range)
includes leading doc-comment trivia, optionally extending through
decorators/attributes.

## 1.1 Compute trivia range from any node

- [ ] New file `src/refactor/trivia.ts` exporting:

  ```ts
  export function computeLeadingTriviaRange(
    node: SyntaxNodeLike,
    source: string,
    languageId: string,
    mode: TriviaMode,
  ): Range; // returns the original node range when mode === "exclude"
  ```

  Algorithm:

  1. Climb the same ladder `extractLeadingDocstring` already uses
     (`identifier → declaration`, `variable_declarator → declaration`,
     `… → export_statement`) — extract that climb into a small
     `getDeclarationAnchor(node)` helper and **share it with the existing
     docstring extractor** (refactor `extractLeadingDocstring` to call it).
     This is required by the project's parity rule: docstring text and
     range must agree on what "the symbol" is.
  2. Walk `previousNamedSibling` while the sibling type is in the
     language's trivia set:
     - **All langs:** `comment`, `line_comment`, `block_comment`
     - **`leading-all` only, language-specific:**
       - `ts`/`tsx`/`js`/`jsx`: `decorator`
       - `python`: `decorator`
       - `java`/`kotlin`: `modifiers` containing `annotation` /
         `marker_annotation` (capture the whole `modifiers` node)
       - `csharp`: `attribute_list`
       - `rust`: `attribute_item`, `inner_attribute_item`
       - `swift`: `attribute`
       - `php`: `attribute_list`
       - `go`: no decorators — skip
     The exact mapping table lives in `src/refactor/trivia-table.ts`.
  3. If no trivia siblings, return the bare node range.
  4. Otherwise return `{ start: firstTriviaNode.startPosition, end: nodeRange.end }`.
- [ ] **Attachment rule (critical).** A trivia sibling is "attached" to
      the declaration **only if there is no blank line between them**.
      `previousNamedSibling` skips whitespace nodes, so we must inspect
      the source slice between the trivia's `endIndex` and the
      declaration's (or next-walked node's) `startIndex`. If the slice
      contains `\n\s*\n`, stop walking. Without this rule, file-header
      license comments leak into the first symbol's range.
- [ ] **Python special case:** triple-quoted docstrings sit *inside* the
      function body and are already covered by the bare range. Trivia
      computation must not double-count them. Test: a Python function
      with both a `# leading comment` and an internal `"""docstring"""`
      yields a range that starts at the `#` line and ends at the bare
      end line.
- [ ] **Re-export of declarations:** when an `export_statement` wraps the
      declaration, the leading docs sit before the `export_statement`,
      not the inner declaration. The shared anchor helper handles this;
      add a regression test.

## 1.2 Public API to derive trivia ranges

- [ ] Extend `listSymbols` (`src/indexer/symbols.ts:113`) with an
      optional `trivia?: TriviaMode` option. When set, post-process each
      `SymbolListItem` so `range` reflects the requested mode. We do
      **not** mutate the cached `SymbolDef` — we compute the expanded
      range on demand using the cached AST node when available, falling
      back to a fresh parse when not.
- [ ] Add `getSymbolRange(index: ProjectIndex, def: SymbolDef, opts:
      SymbolRangeOptions): Range` in `src/refactor/trivia.ts`. This is
      the canonical public entrypoint — `listSymbols` becomes a thin
      caller of it.
- [ ] **Cache plumbing — call-scoped only.** Per the
      "Stale Index, Fresh Tree" contract, do **not** attach a tree
      cache to `ProjectIndex`. Pass an optional
      `Map<FileId, { tree: SyntaxTreeLike; sourceHash: string }>` memo
      down into `getSymbolRange` from the refactor entrypoint. Memo
      lives for the duration of one `renameSymbol` / `moveSymbol` /
      `extractFunction` call and is discarded on return. Memo key
      must include the parser backend (`native` vs `js`) — fallback
      parses with the wrong backend produce subtly different
      node-type strings, breaking the trivia table. Reuse
      `opts?.nativeMode` resolution from
      `locals-and-exports.ts:286-317`. `sourceHash` lets the memo
      invalidate if the same call somehow loads the file twice across
      an edit boundary.

## 1.3 CLI + agent-tool exposure

- [ ] `codegraph list-symbols --trivia=leading-doc|leading-all|exclude`
      flag in `src/cli.ts` (whichever subcommand currently invokes
      `listSymbols`). Default `exclude` so existing scripts don't shift.
- [ ] `tool_findSymbol` / `tool_getFileOverview` in `src/agent-tools.ts`
      gain `trivia` option in their JSON input shape and surface the
      expanded range in the response.
- [ ] Update `docs/cli.md` and `codegraph-skill/codegraph/SKILL.md` in
      the same change (project rule, `AGENTS.md:15-16`).

## 1.4 Tests

- [ ] `tests/refactor/trivia.test.ts` — one fixture per language we
      claim parity for. Each fixture: a symbol with (a) JSDoc-style
      block, (b) line-comment block, (c) decorator/attribute, asserts
      both `leading-doc` and `leading-all` ranges.
- [ ] Add cases to `tests/native-semantic-parity.test.ts` covering at
      least one trivia mode per native-supported language so the JS and
      native paths stay aligned.
- [ ] `tests/languages/{python,csharp,typescript,rust,java,go}.test.ts`
      — each gets a `describe("trivia ranges", …)` block.

### Rationale

Doing trivia as an opt-in derived view (instead of mutating the indexed
range) keeps existing consumers — chunkers, graph renderers, hash-based
manifests — unaffected. The same helper underpins refactor edits, so
"select with docs" and "move with docs" agree by construction.

---

# Phase 2 — Refactor: Rename

**Goal:** given a symbol handle, produce text edits renaming the
declaration and every reference.

## 2.1 API

```ts
// src/refactor/rename.ts
export interface RenameOptions {
  /** Apply edits inside string literals/comments? Default: false. */
  includeStringMatches?: boolean;
}

export async function renameSymbol(
  index: ProjectIndex,
  id: SymbolHandle,
  newName: string,
  opts?: RenameOptions,
): Promise<RefactorResult>;
```

## 2.2 Implementation

- [ ] Validate `newName`: per-language identifier regex **and**
      reserved-word list from a small
      `isValidIdentifier(languageId, name): { ok: true } | { ok: false; reason: string }`
      helper in `src/refactor/identifier.ts`. Reserved-word lists per
      language live alongside it. Reject Unicode lookalikes the same
      way (`AGENTS.md:18`).
- [ ] Resolve the def via `resolveSymbolId(index, id)`. If null →
      `{ status: "error", reason: "unknown handle" }`.
- [ ] Call `findReferencesById(index, id)` to discover *which* sites to
      edit (file + symbolic location). Treat the returned `Range`
      values as **hints, not authorities** — they came from the cached
      index and may be stale.
- [ ] **For each touched file, read from disk and re-parse**, then
      locate the identifier tokens via the fresh tree (search for
      `localName` occurrences inside the freshly-parsed declaration /
      reference nodes that the index pointed at). Emit one `TextEdit`
      per fresh-tree token with `newText = newName`. This makes rename
      robust to: external edits since last index, prior refactor steps
      in the same batch, and trivia drift.
- [ ] Emit one edit for the declaration's identifier. The declaration
      identifier range is the *name* node, not the wrapper —
      `SymbolDef.range` covers the wrapper, so we need a second range:
  - Add `SymbolDef.nameRange?: Range` populated in
    `buildSymbolDef` (`locals-and-exports.ts:258`) from the `name`
    capture's range. This is a small, additive index change.
  - Migration: `SymbolDef` is on disk only via SQLite mirror; treat
    `nameRange` as optional so older indexes still load
    (`AGENTS.md:17` schema-migration rule). Add an `ALTER TABLE`
    backfill in the SQLite writer plus a regression test starting from
    an older schema.
- [ ] Imports: when the declaration is exported under one alias and
      imported under another (TS `import { foo as bar }`), only the
      *exporting* and *binding* sides change. The existing reference
      resolver already produces only same-binding refs — verify with a
      dedicated test, do not re-implement.
- [ ] Default exports: when renaming the local of a default export, do
      not change the keyword `default` in `export default`. Add a
      regression test.
- [ ] Re-exports (`export { foo } from "./bar"`): the re-export is a
      reference to `foo` and must rename. Test.
- [ ] **Collision check is per-scope, not just def-site.** A new name
      may shadow an existing binding at any reference site too. For each
      reference's enclosing module, run `buildScopeIndexFromSource` and
      look up `newName` in the scope chain at that reference. If any hit
      that isn't the symbol being renamed, return `unsupported` with a
      list of conflicting locations.
- [ ] Reject and return `unsupported` when:
  - The symbol is `kind === "import"` (rename the *original* declaration instead)
  - The new name collides at the def site or any reference site (above)
  - The new name is a language reserved word (`isValidIdentifier`)

## 2.3 CLI

- [ ] `codegraph refactor rename (--symbol <handle> | --at <file>:<line>:<col>) --to <newName> [--apply] [--trivia=…] [--json] [--git]`
- [ ] `--at` resolves to a handle via `goToDefinition` then proceeds.
      Lets agents skip the handle round-trip.
- [ ] `--apply` runs `applyEdits`; without it, prints a unified diff.
- [ ] `--json` returns the same `RefactorResult` shape the tool wrappers
      return (single canonical schema across CLI + agent-tools).

## 2.4 Tests

- [ ] `tests/refactor/rename.test.ts` per language (TS, JS, Python, Go,
      Rust, Java, C#) — each covers: function, class, type-alias,
      module-level variable, with cross-file references and an alias
      import.
- [ ] Failure cases: identifier collision, invalid identifier, unknown
      handle, attempting to rename an import alias.

### Rationale

Rename is the simplest refactor and exercises every sub-system the
later phases need: handle resolution, reference scanning, edit
emission, identifier validation. Get this rock-solid before move.

---

# Phase 3 — Refactor: Move

**Goal:** move a symbol declaration (with its doc trivia) from file A
to file B. Update imports/exports so the world still compiles.

## 3.1 API

```ts
export interface MoveOptions {
  trivia?: TriviaMode;          // default "leading-all"
  createTargetFile?: boolean;   // default true
  exportFromTarget?: boolean;   // default true — `export` keyword in target
  leaveSourceShim?: boolean;    // default false — `export { x } from "./target"` in source
  importStyle?: "named" | "default" | "preserve"; // default "preserve"
}

export async function moveSymbol(
  index: ProjectIndex,
  id: SymbolHandle,
  targetFile: FileId,
  opts?: MoveOptions,
): Promise<RefactorResult>;
```

## 3.2 Implementation

- [ ] Resolve def. Reject if `def.file === targetFile` (`unsupported`).
- [ ] **Target collision pre-flight.** If the target module already
      declares a binding with the same `localName`, reject as
      `unsupported` with the conflicting handle in `reason`.
      Same check against `__all__` / re-export aliases in the target.
- [ ] **Re-parse the source file from disk** before computing ranges.
      Compute the **full source range** to extract using
      `getSymbolRange` against the fresh tree, with
      `trivia: opts.trivia ?? "leading-all"`. Store the source slice
      as `body`. Cached `def.range` is treated as a locator, not as
      authoritative offsets.
- [ ] Emit a deletion `TextEdit` for that range in the source file.
      Trim a trailing blank line if present so we don't leave a double
      blank.
- [ ] Emit an insertion `TextEdit` for the target file:
  - If file does not exist and `createTargetFile`, insertion at offset 0.
  - Else, append after the last import-statement block (compute via
    `mod.imports`'s last range; fall back to offset 0).
  - Prefix `body` with `\n` if needed.
- [ ] **Export shape in the target.** If the source declaration was
      `export …`, preserve the `export` keyword in the moved text. If
      it wasn't exported, but `exportFromTarget` is true, wrap or
      prepend `export` per the language. Per-language wrap rules live
      in `src/refactor/exportShape.ts`:
  - TS/JS: prepend `export `.
  - Python: nothing — module-level names are exported by name; ensure
    `__all__` updates if present.
  - Go: capitalize first letter? **No** — that's a rename, not a move.
    Reject move when crossing package boundaries with an unexported name.
  - Rust: prepend `pub`.
  - Java/C#/Kotlin/Swift: requires class context — `move` between
    top-level files is `unsupported` for these in v1.
- [ ] **Import rewriting in every file referencing the symbol:**
  - For each module that imports from the original file, change the
    specifier to point at `targetFile`. **Before adding a new helper,**
    grep `src/util/specifiers.ts` and `src/util/resolution.ts` for an
    existing `relativize`/`toRelative` helper — only add
    `relativizeSpecifier(fromFile, toFile)` if none exists.
  - If a module imports *other* names from the source file, split the
    import into two statements rather than rewriting the whole list.
  - For files that referenced the symbol but did not import it (same
    file as the declaration), add a new import at the top of the
    surviving source file pointing at the target.
- [ ] **Optional source-shim** (`leaveSourceShim: true`) emits
      `export { x } from "<target>"` in the original file. Useful for
      staged migrations where some importers live outside the indexed
      workspace and rewriting them is impossible. Default off because
      shims accumulate.
- [ ] Reject as `unsupported` when:
  - The symbol participates in an export-star chain we can't statically
    follow (`getApiSurface` returns `exportStar` upstream).
  - Multiple sibling declarations share the wrapper node (e.g.
    `const a = 1, b = 2` — would split the declarator; v2 handles).
  - Language is in `{java, kotlin, swift, csharp}` and the symbol is
    not a top-level free function (class members need a host class —
    out of scope v1).

## 3.3 Tests

- [ ] `tests/refactor/move.test.ts`:
  - Move an exported function across two files, with three importers,
    one of which imports two unrelated names → expect import split.
  - Move with leading JSDoc → docs travel.
  - Move into a brand-new file with `createTargetFile: true`.
  - Reject move with `export *` chain.
  - Per-language coverage matching `docs/language-parity.md` —
    add an entry to `docs/scenario-catalog.md` (`AGENTS.md:12`).

### Rationale

Move is the highest-value agent operation: agents reorganize code more
than they rewrite it. The hard part is import rewriting, and we already
have the import resolution pipeline. The trivia phase ensures the docs
follow the symbol — without that, every `move` is a regression.

---

# Phase 4 — Refactor: Extract

**Goal:** extract a contiguous code region into a new top-level
function in the same file (and, optionally, then `move` it to a new
file via Phase 3 composition).

## 4.1 API

```ts
export interface ExtractOptions {
  newName: string;
  /** When set, after extracting also move into this file. */
  intoFile?: FileId;
  /** Preserve `async` if any awaited expressions in region. Default true. */
  preserveAsync?: boolean;
}

export async function extractFunction(
  index: ProjectIndex,
  region: { file: FileId; range: Range },
  opts: ExtractOptions,
): Promise<RefactorResult>;
```

## 4.2 Implementation (v1, narrow)

- [ ] **Re-parse the file from disk** (don't trust any cached tree).
      Validate the region: must be a contiguous statement list inside a
      single function/method body. Use the fresh tree to find the
      `block`/`function_body` containing both endpoints; reject otherwise.
- [ ] **Free-variable analysis:** `buildScopeIndexFromSource`
      (`src/indexer/scope.ts`) returns *module-level* scope. For
      region-level analysis, walk the cached tree from the region's
      enclosing block up to the module root, collecting bindings at
      each block. New helper
      `collectBindingsInScopeChain(tree, region): { defined, referenced }`
      lives in `src/refactor/scope-region.ts`. Inputs = referenced
      outside ∩ not defined inside. Outputs = defined inside ∩
      referenced *after* region in the same function.
- [ ] **v1 reject when:**
  - Region contains `return`, `break`, `continue`, `yield`, `await`
    *that targets an outer function*, or labelled jumps. Easiest to
    detect via tree-sitter node-type set per language.
  - Region defines functions/classes (could capture `this` — punt).
  - Language is not in v1 set: `{ts, tsx, js, jsx, python}`. Other
    languages return `unsupported` until v2.
- [ ] Emit edits:
  - Replace region with `newName(...inputs)` (or
    `[outA, outB] = newName(...inputs)`).
  - Insert new top-level function **immediately before the enclosing
    function's full trivia-aware range** (so any docs/decorators on the
    enclosing function stay attached to it, not to the inserted helper). Code:
    ```
    function newName(inputs): returnShape { …region… return outputs; }
    ```
    Per language, use `def`, `function`, `const … = (…) =>`, etc. The
    existing language definitions hold enough metadata to choose
    syntax; one helper per language in `src/refactor/extract-emit/`.
- [ ] If `intoFile` set, run `moveSymbol` on the freshly created
      function as a follow-up step in the same `RefactorResult`.

## 4.3 Tests

- [ ] `tests/refactor/extract.test.ts` covering: pure region (no
      outputs), single-output region, multi-output region, region with
      conditional flow, region with closure over outer var.
- [ ] Reject cases: region with `return`, region with `await` outside
      an `async` enclosing function, region spanning two functions.

### Rationale

Extract is the operation agents currently fake by rewriting code wholesale
and hoping. Even a narrow v1 (no early-return / no labelled jumps) covers
the >80% case agents actually want, and reuses scope analysis we already
have.

---

# Phase 5 — Surface (CLI + agent-tools + skill)

**Goal:** put the new APIs in agents' hands.

### Tasks

- [ ] CLI subcommands in `src/cli.ts` (also surface help text in
      `src/cli/help.ts`):
  - `codegraph refactor rename (--symbol <handle> | --at <file>:<line>:<col>) --to <name> [--apply] [--json] [--git]`
  - `codegraph refactor move   (--symbol <handle> | --at <file>:<line>:<col>) --to-file <path> [--leave-shim] [--apply] [--json] [--git]`
  - `codegraph refactor extract --file <path> --range <startLine:endLine> --to <name> [--into-file <path>] [--apply] [--json] [--git]`
  - All three share the canonical `RefactorResult` JSON shape.
  Default output: unified diff to stdout. With `--apply`, write files
  and report `{ written: [...], conflicts: [...] }`.
- [ ] JSON-tool wrappers in `src/agent-tools.ts`:
  - `tool_refactorRename`, `tool_refactorMove`, `tool_refactorExtract`.
  Each returns `{ status, edits, warnings, diff }` with the same
  `RefactorResult` shape plus a pre-rendered diff field.
- [ ] Re-export from `src/index.ts` under a new "Refactor APIs" block.
- [ ] Update `docs/cli.md`, `docs/library-api.md`, `docs/agent-workflows.md`,
      `codegraph-skill/codegraph/SKILL.md`, `README.md` ToC + section, and
      `docs/language-parity.md` (which langs support which op) and
      `docs/scenario-catalog.md` (`AGENTS.md:9-16`).

### Rationale

The skill file is what makes agents actually use new commands —
miss it and the feature is invisible.

---

# Phase 6 — Hardening

### Tasks

- [ ] **Idempotence test (tightened):** after `applyEdits` succeeds,
      re-running the same `refactor*` call against the post-state
      returns `edits.length === 0` and `status === "ok"`. Stronger than
      "diff is empty" because it exercises the resolver too.
- [ ] Round-trip test: rename `A → B` then `B → A` reproduces the
      original buffer byte-for-byte (including line endings).
- [ ] Concurrency / overlapping-edit test: run rename + move on the
      same file in one batch; `applyEdits` must surface a conflict
      cleanly.
- [ ] Performance test: 10k-symbol fixture rename — assert no
      re-parse storm; verify the per-file tree memo introduced in
      Phase 1.2 is hit.
- [ ] Add a `tests/refactor/parity.test.ts` that walks
      `docs/language-parity.md`'s claimed support matrix and asserts
      every "supported" cell has at least one passing test
      (`AGENTS.md:11-12`).

---

# Risks & Open Questions

1. **Reference fidelity ceiling.** Rename and move inherit
   `findReferences`'s false-negative rate. Document this in
   `docs/refactor.md` — agents must `findReferences` first, eyeball
   the count, and decide whether to apply.
2. **CRLF on Windows.** `_sourceLines = source.split(/\r?\n/)` already
   handles read; `applyEdits` must echo the file's existing line ending
   on insertion (detect via first `\r\n` occurrence, default to `\n`).
3. **Native vs JS path drift.** Trivia detection runs on tree-sitter
   nodes regardless of backend, so the same code path serves both.
   Verify in `tests/native-semantic-parity.test.ts`.
4. **`SymbolDef.nameRange` schema migration.** Optional column in the
   SQLite mirror; older rows return `undefined` and rename falls back
   to "find the identifier inside `range` whose text equals `localName`"
   — write that fallback and a regression test that loads an
   older-schema DB.
5. **Decorator capture in TS/JS.** TS decorators desugar at compile
   time but tree-sitter still emits a `decorator` sibling node — the
   trivia walk picks them up uniformly. Validate with a TS class
   fixture using stage-3 decorators.
6. **`SymbolHandle` index drift — bounded by design.** Handle format is
   `file::name::startIndex` (`src/indexer/symbols.ts:13`). After
   `applyEdits` runs, the cached `startIndex` no longer matches disk.
   The "Stale Index, Fresh Tree" contract makes this expected, not
   hazardous: refactor entrypoints re-resolve the handle's *symbolic*
   target (`file::name`) against a fresh parse before emitting edits,
   so a single stale handle still works for one operation. Document
   that handles are valid for one refactor call against the
   `ProjectIndex` snapshot they came from; `RefactorResult` does not
   echo post-edit handles — callers re-index to obtain fresh ones for
   subsequent calls.
7. **Move + rename composition.** Some agents will want "move and
   rename in one go". Don't add a fused API in v1 — document the
   sequence (rename, re-index, move) instead. Composition introduces
   a second collision matrix we'd rather defer.

---

# Suggested Execution Order

1. Phase 0 (1 day)
2. Phase 1 (2-3 days; the docstring-extractor refactor + parity tests
   are most of the cost)
3. Phase 2 — Rename (2 days)
4. Phase 5 surfaces for trivia + rename only — ship as v0.X
5. Phase 3 — Move (3-4 days)
6. Phase 5 surfaces for move — ship as v0.Y
7. Phase 4 — Extract (3-5 days, narrow v1)
8. Phase 6 hardening, then v1.0 of the refactor API.

Each phase ends in a green CI run and a single PR. Don't bundle.
