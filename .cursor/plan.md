## Deep Impact PR Review Plan (LLM + codegraph)

### Goal
Automate impact analysis for PRs by using a code index to find references to changed functions and perform context-aware review. Analyze parameter usage in the base (before) commit and return-value usage in the head (after) commit, then surface actionable findings with direct links.

### Scope
- Languages: TypeScript/JavaScript/Python (parity with the library)
- Changes targeted: function/method signature changes (parameters and return types/semantics)
- Output: PR comment summarizing risks, links to impacted sites, suggested fixes

### Commit selection
- before (base for params): merge-base of PR base and head, or PR base SHA if merge-base is unavailable
- after (head for returns): PR head SHA (or merged ref `refs/pull/<n>/merge`)

### Architecture
- Indexer (codegraph):
  - Build project-wide index with `buildProjectIndex(root, { threads, cache: 'disk', cacheStrict? })`
  - Provides `findReferences`, `goToDefinition`, `resolveExport`, symbol graphs

- Diff analyzer:
  - Collect changed files and hunks between before and after
  - Identify changed function definitions near hunks
  - Map candidate symbols across before/after by file path and local name (best-effort)

- Signature extractor:
  - For a definition, parse its declaration node and extract:
    - Params: names, optional/defaulted, destructuring structure, rest/varargs, rough named keys (for object patterns)
    - Return: TS return annotation or Python return annotation; async/Promise flip heuristic
  - Functions used: `parseFile`, `supportForFile`, `languageForFile`, `sliceText`

- Reference collector and context classifier:
  - Parameters (before): `findReferences(indexBefore, { def })` then classify each reference as a callsite, extract:
    - argc, argument kinds (object/string/number/fn/spread/expr)
    - object-arg named keys (to detect missing required keys post-change)
  - Returns (after): `findReferences(indexAfter, { def })` then classify usage:
    - awaited vs not, member access on result, destructuring of result (object keys)
  - Optional: cross-check via `goToDefinition` for ambiguous contexts

- LLM evaluator:
  - Input JSON per changed function:
    - signature deltas { paramsDelta, returnsDelta }
    - referencesBefore[]: contextualized callsites (base)
    - referencesAfter[]: contextualized result usage (head)
  - Task: rate breakage likelihood, explain briefly, suggest minimal fix per site

- Reporter:
  - Generate concise Markdown for PR comment
  - Include links to GitHub blob lines: base links for parameter callsites; head links for return usage
  - Attach a summary table and a truncated list per function (with counts)

### Data flow
1) Checkout base and head worktrees
2) Build indexes with disk caching:
   - `.codegraph-cache/index-v1` per SHA to speed up re-runs
3) Find changed definitions (near diff hunks)
4) Extract before/after signatures, compute deltas
5) Collect references for before (params) and after (returns)
6) Classify reference contexts with lightweight AST inspection
7) Bundle JSON for LLM; post-process into PR comment

### Heuristics and deltas
- Param delta (before vs after):
  - Count of newly required positional params
  - Object-pattern keys: added/removed keys (signal if callsite supplies those)
  - Presence of new rest/varargs not considered breaking

- Return delta (before vs after):
  - Promise/async flip detection (annotation or async keyword)
  - Object result shape: presence of destructured keys (best-effort)

### Library APIs used
- `buildProjectIndex(root, opts)`
- `findReferences(index, { def } | { file, line, column })`
- `goToDefinition(index, req)` (optional)
- `parseFile(file)` + `supportForFile` + `languageForFile` (for AST context)
- `listProjectFiles`, `collectGraph` (optional visualization)

### JSON handed to the LLM (per function)
```json
{
  "target": { "file": "...", "name": "...", "defLinkHead": "...", "defLinkBase": "..." },
  "deltas": {
    "params": { "addedRequired": 1, "objPropDelta": { "added": ["x"], "removed": [] } },
    "returns": { "promiseFlip": true, "before": {"async": false, "text": ""}, "after": {"async": true, "text": ": Promise<Result>"} }
  },
  "beforeRefs": [
    {
      "file": "...", "line": 42,
      "linkBase": "https://.../blob/BASE/...#L42",
      "linkHead": "https://.../blob/HEAD/...#L42",
      "ctxStart": 37, "ctxEnd": 48, "ctx": "...6 lines...",
      "shape": { "kind": "call", "argc": 2, "argKinds": ["object","string"], "namedObjProps": ["id","name"] }
    }
  ],
  "afterRefs": [
    {
      "file": "...", "line": 88,
      "linkHead": "https://.../blob/HEAD/...#L88",
      "ctxStart": 83, "ctxEnd": 94, "ctx": "...6 lines...",
      "shape": { "kind": "call", "awaited": false, "member": null, "destructured": { "kind": "object", "props": ["ok","value"] } }
    }
  ]
}
```

### GitHub Action (orchestration outline)
1) Checkout base and head
2) Setup Node 18+
3) Cache `.codegraph-cache/index-v1` for base and head
4) Install tool securely:
   - `npm install github:lzehrung/codegraph` (verified source)
5) Run collector script to produce `llm-impact.json`
6) Run LLM step to generate `llm-impact.md`
7) Post comment to PR via `actions/github-script`

### Collector responsibilities
- Build two indexes (base/head)
- Identify changed function defs from diff hunks
- Extract signatures before/after and compute deltas
- Collect references and classify contexts:
  - Before for params (callsite analysis)
  - After for returns (result-usage analysis)
- Emit `llm-impact.json` with all data for the LLM step

### LLM prompt sketch (per function)
- Inputs: deltas + references with context
- Instruction:
  - If params added/changed, check each before callsite for missing required args or missing object keys
  - If return changed to Promise/async, check after usage for missing `await` or misused result (member access on Promise)
  - Propose minimal fixes; rate severity (high/med/low)

### Performance
- Use `threads: 8–16` and disk cache
- Limit analysis to files in the dependency closure of changed files if needed (future)
- Truncate per-function reference list in comment; attach full JSON as artifact if large

### Risks & limitations
- Heuristics approximate param and return shapes; not a type-checker
- Namespace/re-export chains handled best-effort via exported locals
- Large PRs may require pruning/thresholds for comment length

### Deliverables
- `ci/llm-deep-impact.mjs` (collector)
- `ci/llm-post.mjs` (LLM + comment formatter)
- GitHub Action workflow `/.github/workflows/deep-impact.yml`
- Plan file `.cursor/plan.md` (this document)

### Acceptance criteria
- On a PR that changes function signatures, a PR comment appears with:
  - Impact summary per function (counts, severity)
  - Direct links to callsites (base) and result usages (head)
  - Concise fix suggestions
  - No false-positive spam on unrelated files


