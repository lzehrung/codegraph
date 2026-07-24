# Cold-start and explore latency opportunities

Status: Research notes (follow-up to freshness fixes on `fix/bounded-impact-review-candidate-tests`)
Date: 2026-07-23

## Context

PR #165 bounded `impact`/`review` only. Measured `orient`/`explore`/`search`/`refs` on sibling repos showed:

- Cold CLI: 4–11s on ~150–650 file repos
- Warm `orient`: ~0.5s when the index settles
- Warm `search`/`explore`: still 1–3.5s
- Sheetflare looked "warm-broken" with perpetual `Updated project index: 14 files`

Two freshness bugs fixed alongside this note:

1. Hard-ignore `.codegraph/` + `.codegraph-cache/` in discovery; init also gitignores `.codegraph-cache/`
2. Stop force-reparsing git dirty `lastCommit...WORKTREE` files when signatures already match

Sheetflare warm `orient` now settles (~0.49s/run, no perpetual update).

## Where the remaining time goes

CLI one-shot path (`createAgentSession` → `loadProject`):

1. Node process floor (~0.35–0.40s)
2. Native `.node` load (Windows also hashes/copies via runtime cache)
3. Incremental index open: manifest + git reconcile + snapshot JSON hydrate
4. For default hybrid `search` / `explore`: eager detailed symbol-graph load/build

`orient` already uses `symbolGraph: "skip"`. `refs` skips the agent session and goes straight to incremental index + `findReferences`.

Long-lived MCP already amortizes (1)/(2)/(4) across tools after warmup.

## Ranked follow-ups

| Rank | Opportunity | Effort | Expected win | Notes |
|------|-------------|--------|--------------|-------|
| 1 | Defer detailed symbol graph for hybrid `search` / `explore` until a result actually needs it | Medium | High on warm CLI explore/search (often 0.5–2s) | Today `searchNeedsSymbolGraph` only skips for `path`/`text`/`sql`; explore always starts hybrid search |
| 2 | Shrink / speed project-index-snapshot hydrate (binary or chunked sidecar) | Medium–High | Medium warm open | Large JSON snapshot parse shows up even when nothing changed |
| 3 | Prefer MCP / shared daemon for agent loops instead of one-shot CLI | Low (workflow) / High (daemon) | High for repeated ops | MCP session already solves process+native+in-memory reuse |
| 4 | Avoid git reconcile work when signatures prove clean without candidate fan-out | Low–Medium | Low–Medium | Freshness fix removed perpetual reparses; further skip of dependent work possible |
| 5 | Non-git discovery fast path for clean trees | Medium | Low–Medium cold | Full `listProjectFiles` still expensive when git fast path unavailable |

## Non-goals / already covered

- Impact/review budgets (#165)
- Warm scoped inspect / no-change review / repeated symbol search (#164)
- Claiming one-shot CLI can match warm MCP without a persistent process

## Suggested next implementation slice

1. Make hybrid `search` load the detailed symbol graph lazily (and teach `explore` not to force it up front).
2. Add a microbench: warm `search`/`explore` before/after on sheetflare + code-review-agent.
3. Only then consider snapshot format changes.
