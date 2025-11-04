<!-- c80aebed-976d-4f87-88c7-a7c4afa4383a 620b01cf-9d6d-4c0d-8431-07afb1bdab09 -->
# Library-Scoped Enhancements for Impact Analysis

### Scope

Focus on richer impact context built solely from the dependency graph, parsed symbols, and AST queries already present. Avoid agent-level responsibilities (security scans, checklists, heuristic test selection beyond imports).

### What We’ll Deliver

- More precise seeding (deleted/renamed files) and better explainability.
- Real symbol-level edges for changed symbols, not same-file heuristics.
- Compact, pruned context subgraphs and helper utilities the agent can pull on demand.
- Minimal helper for “candidate tests” (import-graph only), leaving advanced heuristics to the agent.
- README recipes showing how agents can compose these building blocks for backend-focused reviews.

### Files Likely Touched

- `src/impact/analyzer.ts` (seeding, explain, traversal)
- `src/impact/report.ts` (symbol edges, compact output)
- `src/impact/index.ts` (options thread-through)
- `src/impact/types.ts` (lightweight explain fields, compact shape)
- New helpers: `src/impact/context.ts`, `src/impact/helpers.ts`
- Docs: `README.md`

### Notes

- Do not add a `changeType` to core types; instead emit lightweight `explain.hints` flags.
- Keep any “candidate tests” to import-graph only, with optional patterns provided by caller.
- Use existing `astGrep` only in docs/recipes; do not wire scans into the library API.

### To-dos

- [ ] Extend ImpactItem.explain with hints (e.g., signatureChanged, exportChanged)
- [ ] Seed transitive impact from changed files when no symbols or on delete/rename
- [ ] Emit real symbolEdges using detailed symbol graph for changed files (pruned)
- [ ] Add collectImpactContext to return N-hop subgraph and symbol neighbors
- [ ] Add listCandidateTestFiles helper using reverse deps + optional patterns
- [ ] Support compact impact report (indexed arrays) behind an option
- [ ] Test: deleted/renamed file seeds transitive impact with depth > 0
- [ ] Test: symbolEdges connect changed symbol to used symbols (pruned)
- [ ] Test: candidate tests detected via import edges on samples
- [ ] README: backend-focused agent recipes using graph, context, astGrep