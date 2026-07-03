# Plan priority and dependencies

The 16 numbered plan files follow the original finding order. They are not strict implementation priority order.

## Recommended implementation order

### P0: highest immediate user value

1. `2026-07-03-02-mcp-freshness-on-query.md`
   - Prevents stale MCP answers after edits.
   - Can ship without lifecycle commands or shared server work.
2. `2026-07-03-06-explore-facade.md`
   - Gives agents one high-level entry point while preserving existing primitives.
   - Can ship on current search/packet/path/session APIs.
3. `2026-07-03-05-agent-installer-workflow.md`
   - Reduces setup friction using existing MCP and skill surfaces.
   - Does not require bundled distribution.

### P1: useful foundations and narrow CLI wins

4. `2026-07-03-01-project-lifecycle-commands.md`
   - Adds `init`, `status`, `sync`, and `uninit` mental model.
   - Useful foundation for freshness and installer messaging, but not a hard dependency.
5. `2026-07-03-12-affected-tests-command.md`
   - Small, high-value CLI on existing impact/candidate-test logic.
6. `2026-07-03-16-config-extension-mapping.md`
   - Low-risk config improvement.
   - Should land before broad language expansion to avoid touching language detection twice.
7. `2026-07-03-07-read-parity-file-view.md`
   - Improves agent file-read behavior.
   - Strengthens `explore`, but `explore` does not need to wait for it.

### P2: long-running server and graph-intelligence expansion

8. `2026-07-03-03-shared-server-lifecycle.md`
   - Builds on existing HTTP MCP server.
   - Benefits from freshness-on-query, but can be implemented independently.
9. `2026-07-03-10-dispatch-synthesizers.md`
   - Best first step for synthetic/provenance-tagged graph edges.
   - Provides a reusable pattern for later bridge edges.
10. `2026-07-03-08-framework-route-nodes.md`
    - Can ship independently, but should reuse any synthesized-edge provenance conventions if plan 10 lands first.
11. `2026-07-03-11-source-language-expansion.md`
    - Should follow extension mapping if both are planned.
    - One language per PR.
12. `2026-07-03-09-mobile-bridge-edges.md`
    - Should follow the synthesized-edge framework from plan 10 if possible.
    - Highest risk of heuristic debt; keep narrow.

### P3: adoption and release polish

13. `2026-07-03-15-public-docs-benchmarks.md`
    - More credible after freshness/explore improvements land.
    - Can start with local fixtures anytime.
14. `2026-07-03-04-self-contained-distribution.md`
    - Important for broad adoption, but larger operational surface.
    - Better after installer semantics stabilize.
15. `2026-07-03-13-upgrade-command.md`
    - Most valuable after bundled/self-contained distribution exists.
    - Can start as safe `--check` and printed instructions earlier.
16. `2026-07-03-14-privacy-preserving-diagnostics.md`
    - Useful support feature, but not core product behavior.
    - Independent.

## Dependency notes

Hard dependencies are minimal. Most plans are intentionally single-PR vertical slices.

```text
16 config extension mapping -> 11 source language expansion
10 dispatch synthesizers -> 09 mobile bridge edges
02 MCP freshness -> 03 shared server lifecycle (recommended, not required)
07 read-parity file view -> 06 explore facade (helpful, not required)
04 self-contained distribution -> 13 upgrade command (for self-update, not for --check)
01 project lifecycle -> 05 agent installer workflow (helpful messaging, not required)
```

## Suggested first three PRs

1. MCP freshness-on-query.
2. Explore facade.
3. Agent installer workflow.

Reason: these three improve day-to-day agent usefulness without large parser, release, or heuristic-risk changes.

## Suggested graph-intelligence sequence

1. Dispatch synthesizer framework with one concrete pattern.
2. Framework route nodes for one or two frameworks.
3. Mobile bridge edges for one bridge family.
4. Source language expansion one language at a time.

Reason: provenance and confidence metadata should be standardized before adding multiple heuristic graph sources.
