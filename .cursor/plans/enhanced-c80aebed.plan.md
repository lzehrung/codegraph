---
name: Library-Scoped Enhancements for Impact Analysis
overview: ""
todos:
  - id: 5490aa14-41b2-46ef-9067-9fba31c3fd38
    content: Extend ImpactItem.explain with hints (e.g., signatureChanged, exportChanged)
    status: pending
  - id: fa8fce31-9bd0-4067-ba0a-0a522ef0331f
    content: Seed transitive impact from changed files when no symbols or on delete/rename
    status: pending
  - id: faeb6033-100d-4fa8-a8f7-148d442abf11
    content: Emit real symbolEdges using detailed symbol graph for changed files (pruned)
    status: pending
  - id: 41dddf72-27a7-436e-bde5-527a9dda2c4b
    content: Add collectImpactContext to return N-hop subgraph and symbol neighbors
    status: pending
  - id: 7a652b01-2609-4fd0-9b3b-2537948149dc
    content: Add listCandidateTestFiles helper using reverse deps + optional patterns
    status: pending
  - id: 44f71d20-3249-490d-9c74-4a7ad064a70b
    content: Support compact impact report (indexed arrays) behind an option
    status: pending
  - id: 0e58159a-8498-41cd-9456-546fa054c156
    content: "Test: deleted/renamed file seeds transitive impact with depth > 0"
    status: pending
  - id: 6546e6af-9179-4fed-873e-55d7af2add94
    content: "Test: symbolEdges connect changed symbol to used symbols (pruned)"
    status: pending
  - id: 0f85ee2e-7667-4835-92a8-0457e3c8d4fd
    content: "Test: candidate tests detected via import edges on samples"
    status: pending
  - id: 3f0533dd-69cc-43b6-a800-0870adcc81e8
    content: "README: backend-focused agent recipes using graph, context, astGrep"
    status: pending
---

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