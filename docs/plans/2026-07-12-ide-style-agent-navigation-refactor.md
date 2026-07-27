# IDE-style agent navigation and refactor plan

Date: 2026-07-12

## Goal

Make Codegraph expose the semantic operations an agent expects from an IDE or language server while preserving Codegraph's differentiators: deterministic bounded output, stable handles, cross-language operation, root confinement, freshness metadata, explicit provenance, omission counts, and review-grade evidence.

The target workflow is:

```text
find a symbol
  -> inspect definition
  -> inspect references/callers/callees/type relationships
  -> preview a rename or refactor
  -> review exact edits, ambiguities, omissions, and tests
  -> let the agent apply edits with its existing editing tool
```

This plan must be implementable without context from the comparison discussion that produced it. Treat the repository state at implementation time as authoritative and preserve existing public contracts unless this plan explicitly changes them.

## Product decision

Codegraph should become an IDE-like semantic evidence service for agents, not a competing editor.

- Add workspace-symbol lookup, call hierarchy, type hierarchy, implementation lookup, and rename preview.
- Keep `goto`, `refs`, `search`, `get_symbol`, `deps`, `rdeps`, `path`, `explore`, and file views.
- Return semantic edit plans; do not apply source edits in the initial implementation.
- Never convert ambiguous or heuristic sites into automatic rename edits.
- Make unsupported or degraded behavior explicit per language and per result.
- Preserve live-file versus indexed-context freshness semantics.

## Current foundations

Reuse these existing surfaces instead of creating parallel infrastructure:

- `src/indexer/navigation.ts`
  - `goToDefinition()`
  - `findReferences()`
- `src/indexer/symbols.ts`
  - `listSymbols()`
  - `resolveSymbolId()`
  - `goToDefinitionById()`
  - `findReferencesById()`
- `src/indexer/types.ts`
  - `ProjectIndex`
  - `SymbolDef`
  - `SymbolHandle`
  - `Reference`
  - `GoToResult`
  - `FindReferencesResult`
- `src/agent/handles.ts`
  - portable `symbol:`, `file:`, `chunk:`, `graph:`, and `sql:` handles
- `src/agent/symbolLookup.ts`
  - snapshot symbol lookup maps
- `src/agent/search.ts`
  - deterministic ranking, portable handles, provenance, bounded evidence, and follow-ups
- `src/agent/explain.ts`
  - portable-handle resolution and bounded references/snippets
- `src/agent/session.ts`
  - warm snapshot reuse and MCP freshness integration
- `src/mcp/server.ts`
  - typed handlers and `withFreshness()` wrapping
- `src/mcp/tools.ts`
  - flat MCP schemas
- `src/agent-tools.ts`
  - public tool wrappers and path normalization
- `src/graphs/symbol-graph.ts` and `src/graphs/symbol-graph-detailed.ts`
  - existing symbol nodes and semantic edges
- `src/impact/*` and `src/review.ts`
  - changed-symbol handles, candidate tests, risk, and review evidence

Existing tests to extend rather than replace:

- `tests/goto.test.ts`
- `tests/references.test.ts`
- `tests/handles.test.ts`
- `tests/agent-search.test.ts`
- `tests/agent-explain.test.ts`
- `tests/agent-tools.test.ts`
- `tests/mcp-server.test.ts`
- `tests/native-semantic-parity.test.ts`
- nearest `tests/languages/*.test.ts` suites for language-specific behavior

## Scope

### Required features

1. Workspace-symbol lookup.
2. Incoming and outgoing call hierarchy.
3. Supertypes and subtypes.
4. Interface/trait/abstract-member implementation lookup.
5. Rename preview with exact edits and explicit unsafe sites.
6. Refactor evidence packet that composes the operations above.
7. CLI, MCP, library, and agent-tool surfaces for each operation.
8. Stable schemas, bounded output, freshness, analysis metadata, and omission counts.
9. Documentation and cross-language parity updates.
10. Focused performance and correctness benchmarks.

### Non-goals

- Applying edits to the worktree.
- Formatting files.
- General extract-method or move-class automation.
- Compiler-complete type checking.
- Renaming strings, comments, filenames, SQL text, or generated code by default.
- Pretending every supported language has identical semantic depth.
- Adding an LSP server protocol endpoint.
- Replacing existing MCP primitives with one new facade.
- Broad framework dispatch synthesis unrelated to a required feature.

## Cross-cutting response contract

All new agent-facing responses must share one envelope. Reuse existing freshness and analysis types where possible; do not create duplicate definitions with subtly different fields.

```ts
type SemanticResponseEnvelope = {
  schemaVersion: 1;
  root: string;
  analysis: AnalysisSummary;
  freshness: CodegraphMcpFreshness;
  limits: Record<string, number>;
  omittedCounts: Record<string, number>;
};
```

MCP may continue wrapping tool payloads with its existing freshness helper. CLI/library results that do not use the MCP wrapper must still expose equivalent analysis, limits, and omissions. Do not add a generation identifier until the shared-server/snapshot-generation work defines a canonical generation contract.

### Common location

Use one location type for declaration, reference, callsite, hierarchy, and edit ranges:

```ts
type SemanticLocation = {
  file: string;
  range: Range;
  context?: string;
};
```

Requirements:

- Files are project-relative in public CLI, MCP, and agent-tool output.
- Lines remain 1-based and columns remain consistent with existing navigation contracts.
- Ranges are exact source ranges, not whole lines, when the parser provides them.
- `context` is bounded and optional.
- Results sort deterministically by normalized file, start line, start column, then stable handle.

### Common provenance

```ts
type SemanticProvenance = {
  capability: "semantic" | "graph" | "heuristic";
  backend: "native" | "reduced" | "mixed" | "unknown";
  confidence: "high" | "medium" | "low";
  reason?: string;
};
```

Reuse the repository's existing analysis/provenance vocabulary if field names differ. The invariant is more important than this exact alias: every nontrivial semantic relationship must state how it was obtained and how safe it is to use.

## Feature 1: workspace-symbol lookup

### User contract

CLI:

```bash
codegraph symbols "CodeReviewSession" --root . --json
codegraph symbols "review report" --kind class,function --exported --limit 50
```

MCP:

```text
workspace_symbols(query, kinds?, exportedOnly?, includeImports?, fileGlob?, limit?)
```

Library:

```ts
workspaceSymbols(indexOrSession, request);
```

Agent tool:

```ts
tool_workspaceSymbols(root, request, runtimeOptions?)
```

Do not overload `search`. Workspace-symbol lookup has symbol identity semantics and predictable filters; `search` remains hybrid relevance search across paths, text, SQL, and graph evidence.

### Request

```ts
type WorkspaceSymbolsRequest = {
  query: string;
  kinds?: SymbolKind[];
  exportedOnly?: boolean;
  includeImports?: boolean;
  fileGlob?: string;
  limit?: number;
};
```

Defaults:

- `limit`: 50.
- Maximum `limit`: 500.
- `exportedOnly`: false.
- `includeImports`: false.
- Empty or whitespace-only query is rejected unless a narrow `fileGlob` or `kinds` filter is supplied. Do not allow an unbounded whole-index dump.

### Response

```ts
type WorkspaceSymbolItem = {
  handle: string;
  name: string;
  localName: string;
  qualifiedName?: string;
  kind: SymbolKind;
  location: SemanticLocation;
  exported: boolean;
  provenance: SemanticProvenance;
};

type WorkspaceSymbolsResponse = SemanticResponseEnvelope & {
  query: string;
  symbols: WorkspaceSymbolItem[];
};
```

### Matching and ranking

Order by:

1. Exact qualified-name match.
2. Exact local/exported-name match.
3. Case-insensitive exact match.
4. Prefix match.
5. Tokenized camelCase/PascalCase/snake_case match.
6. Remaining deterministic substring match.

Then prefer:

- exported over non-exported when scores tie;
- definitions over import aliases unless `includeImports` is true and the alias is the exact query;
- source over tests over docs only as a tie-breaker, not as hidden filtering;
- normalized file/range/handle ordering for final stability.

Do not use vector search. Do not let ordinary prose tokens outrank an exact symbol identity.

### Implementation shape

- Add `src/indexer/workspace-symbols.ts` for index-level filtering/ranking.
- Add `src/agent/workspaceSymbols.ts` for session loading, portable handles, public normalization, limits, analysis, and omissions.
- Reuse or extend `buildSymbolLookup()`; do not rebuild independent symbol maps on every query.
- If the lookup is expensive, cache it on `AgentProjectSnapshot` or session state and invalidate with the snapshot.
- Exclude graph-only nodes that cannot resolve to a real `SymbolDef` from symbol handles.
- Namespace/star aliases without a real `SymbolDef` remain excluded and contribute explicit import omissions rather than receiving incompatible handles.

### Acceptance tests

- Exact name outranks prose/token matches.
- Qualified name disambiguates same-named symbols.
- Shadowed locals remain separate.
- Imports are excluded by default and included when requested.
- Exported filtering is correct.
- Kind and file-glob filters compose.
- Results are project-relative and deterministic.
- Limit is applied after ranking and omission count records the remainder.
- Reduced mode reports capability honestly.
- SQL objects remain under SQL/search surfaces unless intentionally represented as `SymbolDef`; do not silently mix incompatible handle types.

## Feature 2: call hierarchy

### User contract

CLI:

```bash
codegraph callers <symbol-handle> --depth 1 --limit 100 --json
codegraph callees <symbol-handle> --depth 2 --limit 100
```

MCP:

```text
callers(handle, depth?, limit?, includeHeuristic?)
callees(handle, depth?, limit?, includeHeuristic?)
```

Library:

```ts
findCallers(indexOrSession, request);
findCallees(indexOrSession, request);
```

### Relationship model

```ts
type CallHierarchyEntry = {
  symbol: WorkspaceSymbolItem;
  callsites: SemanticLocation[];
  depth: number;
  provenance: SemanticProvenance;
};

type CallHierarchyResponse = SemanticResponseEnvelope & {
  target: WorkspaceSymbolItem;
  direction: "incoming" | "outgoing";
  entries: CallHierarchyEntry[];
};
```

One entry represents one caller/callee symbol. Multiple callsites between the same pair are grouped and bounded. Do not emit one duplicated symbol entry per callsite.

### Semantics

- `callers`: symbols containing semantic callsites that resolve to the target.
- `callees`: semantic targets called from within the target symbol's source range.
- Depth 1 is direct only.
- Maximum depth is 5.
- Cycle traversal uses visited symbol handles and still reports direct cycle edges once.
- Callsites must be real ranges from source evidence.
- A file-level dependency edge is not a call edge.
- Imports, inheritance, route metadata, and document links are not call edges.
- Heuristic/synthesized calls are excluded by default unless existing graph provenance already marks them and `includeHeuristic` is true.
- If a language cannot attribute a callsite to a containing caller symbol, report a bounded file-level unresolved site separately rather than inventing a caller symbol.

### Required index work

Inspect current native and JS extraction contracts before editing. Prefer adding callsite ownership to existing reference/call records over reparsing source for every query.

Add a query-ready structure if the current graph cannot answer both directions efficiently:

```ts
type CallHierarchyIndex = {
  outgoingByCaller: Map<SymbolHandle, CallEdge[]>;
  incomingByCallee: Map<SymbolHandle, CallEdge[]>;
};

type CallEdge = {
  caller: SymbolHandle;
  callee: SymbolHandle;
  callsite: SemanticLocation;
  provenance: SemanticProvenance;
};
```

Requirements:

- Construct once per project snapshot, lazily if not needed by normal indexing.
- Cache on the snapshot/session, not in an unbounded global map.
- Invalidate with the snapshot.
- Bound fan-out and report omitted symbols and callsites separately.
- Avoid copying whole `SymbolDef` objects into every edge; retain stable handles and resolve on output.

### Files likely touched

- `src/indexer/types.ts`
- `src/indexer/navigation.ts` or new `src/indexer/call-hierarchy.ts`
- native contracts under `src/native/` and `packages/codegraph-native` only if existing extraction lacks callsite target/owner data
- `src/agent/callHierarchy.ts`
- `src/agent/session.ts`
- `src/agent-tools.ts`
- `src/mcp/server.ts`
- `src/mcp/tools.ts`
- CLI command/help/options modules

### Acceptance tests

- Direct caller and callee with exact callsite range.
- Multiple callsites group under one relationship.
- Nested functions attribute calls to the nearest containing symbol.
- Recursive call reports once without infinite traversal.
- Depth traversal is deterministic and bounded.
- Same-named methods on different receiver types do not cross-link.
- Unresolved dynamic calls are omitted or explicitly listed as unresolved; never guessed.
- Native and supported reduced behavior match documented capability.
- Large fan-out reports symbol and callsite omissions.
- Existing `refs` semantics remain unchanged.

## Feature 3: type hierarchy

### User contract

CLI:

```bash
codegraph supertypes <symbol-handle> --json
codegraph subtypes <symbol-handle> --depth 2 --limit 100
```

MCP:

```text
supertypes(handle, depth?, limit?)
subtypes(handle, depth?, limit?)
```

### Response

```ts
type TypeHierarchyRelation = {
  type: WorkspaceSymbolItem;
  relation: "extends" | "implements" | "trait" | "mixin" | "unknown";
  declarationSite?: SemanticLocation;
  depth: number;
  provenance: SemanticProvenance;
};

type TypeHierarchyResponse = SemanticResponseEnvelope & {
  target: WorkspaceSymbolItem;
  direction: "super" | "sub";
  relations: TypeHierarchyRelation[];
};
```

### Semantics

- Only type-like symbols are valid targets.
- Reuse existing detailed symbol-graph inheritance edges where they resolve to actual definitions.
- Distinguish `extends` from `implements` when extraction data supports it.
- Do not collapse a class and same-named interface in another namespace/package.
- Preserve language scoping and import resolution.
- Maximum depth is 10; default 1.
- Cycles are bounded and reported once.
- Ambiguous bases are not linked.

### Implementation shape

- Add `src/indexer/type-hierarchy.ts` or a graph query module operating on existing detailed symbol graph.
- Build forward and reverse adjacency once per snapshot.
- If current edges lose relation kind or declaration site, extend edge metadata at extraction time rather than guessing during query.
- Keep this feature independent of framework route or dynamic-dispatch synthesizers.

### Acceptance tests

Cover at least the existing supported forms used by current semantic parity tests:

- TypeScript/JavaScript class extension and interface implementation where supported.
- Java/C#/Kotlin class/interface relationships.
- Rust trait implementation where current extraction can prove it.
- Swift protocol conformance where current extraction can prove it.
- C++ inheritance.
- Python class inheritance.
- Ambiguous same-name bases remain unresolved.
- Transitive hierarchy, cycles, limits, and omission counts.

When the feature changes a claimed cross-language capability, update `tests/native-semantic-parity.test.ts`, the nearest `tests/languages/*.test.ts`, `docs/language-parity.md`, and `docs/scenario-catalog.md` in the same change.

## Feature 4: implementation lookup

### User contract

CLI:

```bash
codegraph implementations <symbol-handle> --limit 100 --json
```

MCP:

```text
implementations(handle, limit?)
```

### Target types

Accept:

- interface or trait type;
- interface/trait/abstract member;
- abstract/virtual method where override relationships are statically established.

Reject ordinary concrete symbols with a clear target-kind error rather than returning an empty success that looks authoritative.

### Response

```ts
type ImplementationEntry = {
  symbol: WorkspaceSymbolItem;
  relationSite?: SemanticLocation;
  provenance: SemanticProvenance;
};

type ImplementationsResponse = SemanticResponseEnvelope & {
  target: WorkspaceSymbolItem;
  implementations: ImplementationEntry[];
};
```

### Resolution rules

- Type implementations derive from proven `implements`, trait, protocol, or equivalent hierarchy edges.
- Member implementations require both a proven type relationship and compatible member identity under the language's existing resolver.
- Do not use name-only global matching.
- Reuse existing receiver-aware/member-resolution logic where possible.
- Overloads remain distinct when the index preserves signature/arity data.
- If the index lacks enough information to distinguish overloads, return ambiguity metadata rather than all same-named methods as high-confidence results.

### Acceptance tests

- Interface type to implementing types.
- Interface method to concrete method.
- Abstract base method to overrides.
- Same method name on unrelated types excluded.
- Inherited implementation included only once.
- Ambiguous overloads downgraded or excluded with reason.
- Unsupported language returns explicit capability limitation.

## Feature 5: rename preview

### User contract

CLI:

```bash
codegraph rename-preview <symbol-handle> <new-name> --json
codegraph rename-preview <symbol-handle> <new-name> --include-comments
```

MCP:

```text
rename_preview(handle, newName, includeComments?, includeStrings?, includeFilenames?, maxEdits?)
```

Library:

```ts
previewRename(indexOrSession, request);
```

No `rename --apply` command is part of this plan.

### Request

```ts
type RenamePreviewRequest = {
  handle: string;
  newName: string;
  includeComments?: boolean;
  includeStrings?: boolean;
  includeFilenames?: boolean;
  maxEdits?: number;
};
```

Defaults:

- comments: false;
- strings: false;
- filenames: false;
- maximum edits: 5,000;
- reject empty names, path separators, NUL, and names that are syntactically invalid for the target language when a validator exists;
- if no language validator exists, validate conservatively as an identifier and report the limitation.

### Response

```ts
type RenameEdit = {
  file: string;
  range: Range;
  oldText: string;
  newText: string;
  kind: "definition" | "reference" | "import" | "export" | "comment" | "string" | "filename";
  provenance: SemanticProvenance;
};

type RenameUnsafeSite = {
  location: SemanticLocation;
  text: string;
  reason:
    | "ambiguous_target"
    | "unresolved_reference"
    | "dynamic_access"
    | "unsupported_syntax"
    | "parse_degraded"
    | "generated_file"
    | "sensitive_file"
    | "outside_root"
    | "limit_exceeded";
  provenance: SemanticProvenance;
};

type RenameConflict = {
  file: string;
  location?: SemanticLocation;
  reason: "name_collision" | "shadowing" | "duplicate_export" | "invalid_identifier" | "case_only_filesystem_risk";
  existingHandle?: string;
  message: string;
};

type RenamePreviewResponse = SemanticResponseEnvelope & {
  target: WorkspaceSymbolItem;
  newName: string;
  safe: boolean;
  edits: RenameEdit[];
  unsafeSites: RenameUnsafeSite[];
  conflicts: RenameConflict[];
  candidateTests: Array<{ file: string; confidence: "high" | "medium" | "low"; reason: string }>;
};
```

`safe` is true only when:

- the definition resolves uniquely;
- all semantic references selected for editing resolve to that definition;
- no high-confidence collision exists;
- no parse-degraded file that could contain references is known;
- no edit or candidate scan was truncated;
- freshness is `fresh` or `refreshed`;
- every edit range still contains `oldText` in the live file bytes at response time.

A response with `safe: false` is still useful as evidence. It must never be presented as safe merely because ambiguous sites were omitted.

### Edit construction

1. Resolve the portable symbol handle to exactly one `SymbolDef`.
2. Run semantic references using the same snapshot.
3. Include the declaration range.
4. Classify import/export sites using existing `Reference.via` data or equivalent provenance.
5. Read live bytes for every candidate file after root confinement.
6. Verify each range still contains the expected old text.
7. Reject overlapping edits unless they are byte-identical duplicates; deduplicate those.
8. Sort edits by file and ascending range for output. Consumers applying edits should apply in reverse-offset order per file, but Codegraph does not apply them.
9. Compute collisions in the target scope before declaring `safe`.
10. Add candidate tests through existing impact/review candidate-test logic; do not introduce separate test-pattern heuristics.

### Comments and strings

Comments and strings are opt-in, always lower confidence, and never required for `safe: true` unless the caller opted in.

- Search only files already in the project snapshot and within root.
- Return occurrences as candidate edits with heuristic provenance.
- Do not rename partial words by default.
- Do not interpret serialized data, reflection names, routes, SQL strings, or framework metadata as semantic references unless an existing extractor proves the relationship.
- Sensitive files follow existing file-view redaction and access rules.

### Filename suggestions

`includeFilenames` returns suggestions, not normal source edits. Do not move files in this plan.

If a filename convention exactly matches a uniquely resolved public type, return a `filename` suggestion with case-sensitivity risk metadata. Never infer broad folder renames.

### Collision checks

Minimum required checks:

- Same-scope local already uses `newName`.
- Same module already exports `newName`.
- Import alias would collide in a consumer.
- Member rename collides on the same type.
- Case-only rename risk on case-insensitive filesystems.
- New name is invalid for the target language.

If a language-specific scope rule cannot be proven, mark the limitation and do not declare the preview safe.

### Acceptance tests

- Rename exported function across definition, imports, aliases, and calls.
- Rename local symbol without touching shadowed same-name locals.
- Rename method only for the resolved receiver type.
- Rename interface method and implementations only when implementation relationships are proven.
- Same-name unrelated methods remain unchanged.
- Collision produces `safe: false` and no misleading safe plan.
- Stale live range produces unsafe site instead of an edit.
- Changed file during preview cannot yield `safe: true`.
- Ambiguous and unresolved candidates are surfaced.
- Comments/strings excluded by default and bounded when included.
- Overlapping edits deduplicate or fail clearly.
- Project-relative output and root confinement.
- Deleted files and malformed UTF-8 handled without crashing.
- Large rename truncation forces `safe: false` and reports omissions.
- Native/reduced mode differences are explicit.

## Feature 6: refactor evidence packet

### Purpose

Agents should not manually stitch workspace-symbol, references, hierarchy, call hierarchy, and rename results together for every refactor.

Add a read-only composition surface:

CLI:

```bash
codegraph refactor-plan <symbol-handle> --rename <new-name> --json
```

MCP:

```text
refactor_plan(handle, renameTo?, maxReferences?, maxCallers?, maxHierarchy?, includeSource?)
```

### Response

```ts
type RefactorPlanResponse = SemanticResponseEnvelope & {
  target: WorkspaceSymbolItem;
  definition: SemanticLocation;
  references: SemanticLocation[];
  callers: CallHierarchyEntry[];
  callees: CallHierarchyEntry[];
  supertypes: TypeHierarchyRelation[];
  subtypes: TypeHierarchyRelation[];
  implementations: ImplementationEntry[];
  rename?: RenamePreviewResponse;
  candidateTests: Array<{ file: string; confidence: "high" | "medium" | "low"; reason: string }>;
  followUps: string[];
};
```

### Composition rules

- Use one loaded snapshot and one freshness decision for the whole packet.
- Do not call public wrappers that each rebuild or reload the project.
- Deduplicate shared symbol/location data.
- Give each section an independent limit and omission count.
- Default source inclusion to off; stable handles and exact ranges are sufficient for most agents.
- Follow-ups must be copyable CLI commands using portable handles.
- If `renameTo` is absent, return analysis only.
- A rename's `safe` decision remains authoritative; the wrapper must not reinterpret it.

## CLI design

Add focused command modules following current conventions:

- `src/cli/symbols.ts`
- `src/cli/callHierarchy.ts`
- `src/cli/typeHierarchy.ts`
- `src/cli/implementations.ts`
- `src/cli/renamePreview.ts`
- `src/cli/refactorPlan.ts`

Update:

- `src/cli.ts` dispatch
- `src/cli/help.ts`
- `src/cli/options.ts`
- `tests/cli-command-modules.test.ts`
- `tests/cli-options-validation.test.ts`
- focused CLI integration tests for JSON and pretty contracts

Requirements:

- JSON is stable and machine-first.
- Pretty output is concise and includes the target, result counts, unsafe/conflict summary, omissions, and copyable follow-ups.
- All numeric options use existing integer/range validation.
- All paths follow `--root` normalization and confinement.
- Commands reuse shared index flags: cache, native, workers, discovery globs, and gitignore behavior where applicable.

## MCP design

Add tools:

- `workspace_symbols`
- `callers`
- `callees`
- `supertypes`
- `subtypes`
- `implementations`
- `rename_preview`
- `refactor_plan`

Requirements:

- Keep schemas flat JSON objects.
- Tool descriptions state when to use the new tool instead of `search`, `refs`, or file-level `deps`.
- Every index-backed handler uses the existing freshness gate.
- No per-request root override.
- Read-only default remains unchanged.
- Rename preview does not require MCP write access because it writes nothing.
- Limits are server-bounded even if the client requests more.
- Add tools to the operating pattern in `docs/mcp.md` and the bundled skill.

## Library and package exports

Expose stable entry points through existing public modules rather than adding a new package subpath unless the current public API organization requires it.

Likely exports:

```ts
export {
  workspaceSymbols,
  findCallers,
  findCallees,
  findSupertypes,
  findSubtypes,
  findImplementations,
  previewRename,
  buildRefactorPlan,
};
```

Also export request/response types.

Update:

- `src/index.ts`
- `src/agent.ts` or `@lzehrung/codegraph/agent` exports
- `src/indexer.ts` for index-level operations if consistent with existing boundaries
- `docs/library-api.md`
- package export tests

Do not expose internal caches or mutable adjacency maps.

## Stable-handle behavior

Current portable agent handles encode project-relative file, symbol name, line, and column. Preserve that format for this plan unless a separate migration is approved.

Required behavior:

- Every new result uses portable handles, never absolute-path symbol IDs.
- A handle resolves within the current root only.
- A handle that no longer resolves after refresh returns a specific stale/missing-handle result and recommends workspace-symbol lookup; do not silently bind to a same-named symbol elsewhere.
- Rename preview validates the live declaration text even when a handle resolves in the snapshot.
- Review/impact handles should flow into refactor operations when they resolve to symbol handles; add conversion only where identity is proven.

Do not add compatibility aliases or a second symbol-handle format in this feature series.

## Freshness and concurrency

Every operation except raw file reads depends on indexed state.

- Use the current MCP/session freshness gate.
- A composed refactor plan uses one snapshot for all sections.
- If auto-refresh succeeds, report `refreshed`.
- If freshness is stale, navigation may return bounded evidence under the existing policy, but rename preview must set `safe: false`.
- Verify rename edit ranges against live bytes after semantic analysis.
- If files change during range verification, return unsafe sites and do not claim safety.
- Do not hold global locks while reading source or formatting responses.
- Cache query-ready structures by snapshot/session and release them when the session invalidates.

## Performance requirements

The feature is incomplete if it works only by rebuilding detailed graphs or scanning every file for every query.

### Targets to establish before optimization

Add deterministic benchmark fixtures and record environment metadata. Measure at minimum:

- workspace-symbol exact lookup;
- direct callers and callees;
- depth-3 call hierarchy;
- direct subtypes and implementations;
- rename preview with 10, 100, and 1,000 references;
- repeated warm calls through one session;
- peak RSS for hierarchy-index construction.

Do not publish universal latency claims from tiny fixtures. Use these benchmarks to catch regressions and compare implementation strategies.

### Complexity expectations

- Workspace exact-name lookup: expected near `O(matches)` after cached lookup construction.
- Direct callers/callees: expected `O(edges for target)` after adjacency construction.
- Type hierarchy: expected `O(reachable hierarchy edges)` within depth/limit.
- Rename preview: expected `O(candidate references + edited file bytes)`, not all project files unless opt-in comments/strings require text scanning.
- Repeated warm queries must not rebuild lookup/adjacency structures.

### Memory constraints

- Store handles/ranges in adjacency, not duplicate source text or full symbol objects.
- Bound callsites retained per relationship if extraction can generate extreme duplicates; preserve total/omitted counts.
- Avoid global caches keyed by arbitrary roots.
- Session disposal must release derived indexes.

## Stability and safety requirements

- Root confinement on every file read and returned path.
- No writes from any feature in this plan.
- No unsafe rename plan from stale, truncated, degraded, or ambiguous evidence.
- Parser failures become diagnostics/unsafe sites, not crashes.
- Unsupported languages return explicit limitations.
- Deterministic sorting for every collection.
- Numeric and payload limits enforced in CLI, MCP, and library wrappers.
- No source contents from sensitive files unless existing policy allows them.
- No `any`, `as unknown as`, nested ternaries, or nonstandard quote characters.

## Implementation sequence

Each phase must leave the repository compiling and the existing CLI/MCP behavior intact. Prefer one PR per phase.

### Phase 1: shared semantic contracts and workspace symbols

1. Define common response, location, provenance, limit, and omission helpers by reusing existing types.
2. Implement cached workspace-symbol lookup and deterministic ranking.
3. Add portable agent response normalization.
4. Add library and agent-tool exports.
5. Add CLI `symbols` and MCP `workspace_symbols`.
6. Add focused tests and docs.

Exit criteria:

- An agent can resolve an exact/qualified symbol without hybrid search.
- Every result has a portable handle and exact declaration range.
- Existing search ordering and schemas are unchanged.

### Phase 2: type hierarchy and implementations

1. Inventory existing inheritance/implementation edge metadata across supported languages.
2. Add forward/reverse type adjacency per snapshot.
3. Implement supertype/subtype queries.
4. Implement type and member implementation lookup.
5. Add CLI/MCP/library surfaces.
6. Add parity fixtures and documentation with explicit supported/unsupported forms.

Exit criteria:

- Type relationships do not use global name-only matching.
- Ambiguity and unsupported forms are visible.
- Cross-language capability claims have matching tests/docs.

### Phase 3: call hierarchy

1. Inventory call-edge ownership and callsite range data.
2. Extend extraction contracts only where required.
3. Build lazy incoming/outgoing call adjacency.
4. Implement direct and bounded transitive queries.
5. Add CLI/MCP/library surfaces.
6. Add call hierarchy fixtures, cycle tests, and performance baselines.

Exit criteria:

- Direct callers/callees return containing symbols and exact callsites.
- Same-named unrelated methods do not cross-link.
- Warm repeat queries reuse derived indexes.

### Phase 4: rename preview

1. Implement target resolution and language-aware new-name validation.
2. Construct definition/reference/import/export edits from semantic evidence.
3. Add live-range verification, deduplication, overlap detection, and collision checks.
4. Add unsafe-site and conflict reporting.
5. Integrate candidate-test logic.
6. Add opt-in comment/string candidates and filename suggestions only after semantic rename is correct.
7. Add CLI/MCP/library surfaces and exhaustive safety tests.

Exit criteria:

- No source writes.
- `safe: true` requires fresh, complete, nontruncated, nonambiguous, live-verified evidence.
- A plausible stale/ambiguous/collision bug is caught by a deterministic test.

### Phase 5: refactor evidence packet and workflow integration

1. Compose all semantic operations on one snapshot.
2. Add review/impact handle handoff where identity is already available.
3. Add bounded follow-ups and optional rename preview.
4. Add CLI/MCP/library surface.
5. Update agent workflows and bundled skill.
6. Add end-to-end scenario tests from search/review handle through refactor plan.

Exit criteria:

- An agent can move from a review/search handle to a complete refactor evidence packet without re-searching by prose.
- Limits and omissions remain section-specific and honest.

## Test matrix

### Core behavior

- Exact symbol identity and disambiguation.
- Shadowing and same-name unrelated symbols.
- Import aliases and re-exports.
- Definitions and references.
- Callsite ownership.
- Type hierarchy and implementations.
- Rename collisions, unsafe sites, and live-range drift.
- Deterministic ordering and bounds.
- Fresh, refreshed, and stale states.
- Native, reduced, and mixed analysis metadata.

### Boundary behavior

- Empty project.
- Target file removed after indexing.
- Target moved after indexing.
- Very large reference set.
- Reference fan-out over limits.
- Recursive and mutually recursive calls.
- Inheritance cycles or malformed code.
- Same-named symbols across packages/namespaces.
- Case-only rename on Windows/macOS-like filesystems.
- Non-ASCII identifiers where the language supports them.
- Malformed UTF-8 and binary files.
- Root symlinks and outside-root paths.
- Sensitive files.

### Cross-language behavior

For every language included in a claimed capability:

- nearest `tests/languages/<language>.test.ts` scenario;
- shared `tests/goto.test.ts` and `tests/references.test.ts` when relevant;
- `tests/native-semantic-parity.test.ts` when native runtime semantics are involved;
- explicit unsupported/limited fixture when parity is intentionally unavailable.

Do not claim universal implementations or rename safety based on one language.

### MCP behavior

- Tool listing and schemas.
- Flat argument validation.
- Handle mode and target validation.
- Freshness wrapping.
- Limit enforcement.
- Root confinement.
- One session reused across chained operations.
- Rename preview remains available in read-only mode and performs no writes.

### CLI behavior

- Help text and examples.
- JSON schema snapshots/assertions.
- Pretty output summaries.
- Numeric validation.
- Quoted handles and paths with shell metacharacters.
- Shared index flags and `--root` behavior.

## Documentation updates

Every phase that changes public CLI, MCP, library, agent workflow, or cross-language claims must update the relevant canonical documents in the same change:

- `README.md`: concise discovery table and docs links only.
- `docs/cli.md`: commands, flags, schemas, examples, and limits.
- `docs/mcp.md`: tools, argument rules, freshness, and operating pattern.
- `docs/library-api.md`: functions and public types.
- `docs/agent-workflows.md`: search-to-refactor workflow.
- `docs/how-it-works.md`: derived indexes, caching, freshness, and limitations.
- `docs/language-parity.md`: exact hierarchy/call/rename support by language.
- `docs/scenario-catalog.md`: fixture coverage.
- `codegraph-skill/codegraph/SKILL.md`: tool selection and copyable commands.

Keep paragraphs concise and use tables for parity details. Do not inflate the README into the canonical reference.

## Verification commands

During implementation, use the narrowest relevant tests:

```bash
npx vitest run tests/handles.test.ts tests/agent-search.test.ts tests/agent-explain.test.ts
npx vitest run tests/goto.test.ts tests/references.test.ts
npx vitest run tests/agent-tools.test.ts tests/mcp-server.test.ts
npx vitest run tests/cli-command-modules.test.ts tests/cli-options-validation.test.ts
```

Add and run new focused suites such as:

```bash
npx vitest run tests/workspace-symbols.test.ts
npx vitest run tests/call-hierarchy.test.ts
npx vitest run tests/type-hierarchy.test.ts
npx vitest run tests/implementations.test.ts
npx vitest run tests/rename-preview.test.ts
npx vitest run tests/refactor-plan.test.ts
```

When native extraction contracts or cross-language semantic behavior change:

```bash
npm run test:native
```

Before concluding each major PR:

```bash
npm run check
```

## Definition of done

The plan is complete only when all of the following are true:

- Workspace symbol, callers, callees, supertypes, subtypes, implementations, rename preview, and refactor plan exist across CLI, MCP, and supported library/agent-tool surfaces.
- All responses are bounded, deterministic, root-confined, project-relative, provenance-aware, and omission-aware.
- Every semantic operation participates in current freshness behavior.
- Rename preview writes nothing and cannot report `safe: true` from stale, ambiguous, degraded, truncated, conflicting, or live-range-invalid evidence.
- Warm repeated queries reuse derived lookup/adjacency structures.
- Existing navigation/search/explain schemas remain compatible unless an explicit schema version change is documented and tested.
- Claimed language support is documented and covered by language and shared parity tests.
- Agent workflow documentation demonstrates search/review handle to refactor-plan continuity.
- Focused tests and `npm run check` pass.
- No placeholders, stubs, compatibility shims, or unimplemented command surfaces remain.
