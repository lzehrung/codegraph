# Explore first-query ranking tuning

Status: Proposed

Parent plan: [One-command product funnel](./2026-07-27-one-command-product-funnel.md)

## Vision

`explore` should turn a natural-language first question into a bounded, relevant starting set: the right anchors, source packets, candidate tests, and a useful first follow-up. The ranking must remain deterministic and explainable while preserving exact file-path behavior and the search matcher's authority.

This plan corrects the observed installer-preservation query failure without introducing score targets, learned ranking, vectors, fuzzy ML, directory allowlists, or domain-specific boosts.

## Reproduced baseline

In a fresh MCP session on this repository, the observed installer-preservation natural-language query produced 8,216 candidates. Its first two results were `handleExistingMcpSessionRequest` in `src/mcp/server.ts` and `shouldPreserveExistingServer` in `src/installer/registry.ts`, but generic matches also elevated an unrelated CLI-help chunk and benchmark symbols; the first follow-up pointed at a benchmark file.

The response returned ten alphabetically early agent/artifact candidate tests and omitted `tests/installer.test.ts`, with 55 further candidates omitted. This is a first-query failure: the repository contains the installer-preservation implementation and coverage, but the composed response does not make either the obvious next step.

## Root causes

- `buildQueryTerms` in `src/agent/search.ts` ranks every natural-language token, including words such as `how`, `does`, and `the`. Compact matching allows a generic token to match across normalized word boundaries, while symbol-name score multiplication makes those matches disproportionately competitive.
- `findQueryIndexChunkCandidates` in `src/agent/query-index/candidates.ts` unions sidecar candidates for every generic term. Large chunks can therefore become candidates through scattered low-information matches before the authoritative matcher can reject or rank them.
- `compareResults` breaks score ties by label then file, not by useful discriminative coverage. `collectAnchorFiles` subsequently sorts all files by path, `collectPacketTargets` consumes the first handles, and `collectFollowUps` starts from those path-sorted files rather than the primary ranked anchor.
- `candidateTestsForAnchors` in `src/agent/explore.ts` independently derives filename stems from anchors and reverse dependencies, then sorts paths before applying its limit. A broad `agent` stem admits unrelated tests and bypasses `listCandidateTestFiles` in `src/impact/context.ts`, which is already the candidate-test authority.

## Existing architecture to preserve

- `src/agent/search.ts` owns query parsing, matching, ranking, response ordering, rank reasons, and the final bounded result contract. Candidate retrieval may reduce work, but `matchTokenScoreFromNormalized` and the search matcher remain authoritative for whether and how a candidate matches.
- `src/agent/query-index/content.ts`, `candidates.ts`, and `update.ts` provide a durable derived text corpus; their FTS/substr/compact retrieval is candidate selection, never public scoring. `searchCodegraphWithSession` must produce equivalent ordered results with a valid sidecar and with the in-memory fallback.
- `src/agent/explore.ts` composes an existing search response with packets, graph traversal, file view, tests, and follow-ups. CLI and MCP continue to call the same `exploreCodegraphWithSession` contract through their current session paths.
- `extractFileMentions` and `resolveExactFileTarget` keep explicit full-path and unique-basename behavior separate from natural-language ranking. Exact file queries must still include the live bounded file view and must not become subject to prose term filtering.
- `listCandidateTestFiles` remains the sole candidate-test policy. Explore may adapt its structured candidates to `string[]` at the response boundary, but must not duplicate confidence, graph, pattern, or ordering heuristics.

## Invariants

1. A non-path natural-language query uses only rank-bearing terms after prose filtering; identifier-like queries and queries whose filtering would remove every token retain their original tokens.
2. Sidecar and fallback candidate paths use the same rank-bearing terms and are verified by the same matcher before ranking. FTS, substring, and compact lookup never add a score or override a matcher result.
3. Result ordering is deterministic: primary score, semantic capability, distinct discriminative rank-term coverage, then ASCII lexical label, file, and handle tie-breaks. Every tie key must be present in both sidecar and fallback execution.
4. Explicit paths retain their current path-sorted behavior, exact-path file view, and bounded output. Natural-language anchor-derived files retain ranked-anchor order after explicit files; no later composition step may silently path-sort them away.
5. Packet selection is deterministic and file-diverse before taking secondary anchors. Follow-ups begin with the primary anchor file, not a lexically earlier incidental file.
6. Explore passes selected anchor file IDs and selected anchor symbol IDs to `listCandidateTestFiles`, preserves its confidence/path ordering, and applies the existing explore response limit only after that call.
7. Public schemas, existing limits, omission semantics, and `--no-source` behavior stay unchanged. The work changes relevance and composition, not the CLI/MCP surface.

## Vertical PRs

### PR 1: natural-language rank terms and deterministic ties

**Change.** Extend `SearchQueryTerms` in `src/agent/search.ts` with the normalized rank-bearing term set and distinguish natural-language queries from identifier-like input. Filter a small syntax-level prose-term set only for multi-token natural-language input, retain all terms for identifiers and all-filtered input, and pass the same set to `matchTokenScore`, `matchTokenScoreFromNormalized`, `addSymbolResults`, `addPathResults`, and text matching.

Update `compareResults` after primary score to compare semantic capability, the number of distinct rank-bearing terms matched, then ASCII lexical `label`, `file`, and `handle`. Keep rank reasons tied to the same matched terms so the response explains the ordering without exposing an alternate scoring model.

**Candidate parity and cache implications.** Change `findQueryIndexChunkCandidates` and its caller in `src/agent/search.ts` to retrieve from rank-bearing terms only, then retain current exact matching as the gate. Bump `SEARCH_RANKING_VERSION` and `QUERY_INDEX_CANDIDATE_VERSION`; no SQLite schema migration is needed because this changes derived candidate behavior rather than stored row shape, and old sidecars must be reopened through the new cache key rather than trusted by an old result-cache entry.

**Files and tests.** Modify `src/agent/search.ts` and `src/agent/query-index/candidates.ts`. Add focused natural-language, identifier fallback, compact-boundary, deterministic-tie, and sidecar-versus-fallback parity cases in `tests/agent-search.test.ts` and `tests/query-index.test.ts`.

### PR 2: ranked explore composition and authoritative candidate tests

**Change.** Replace `collectAnchorFiles` with an internal anchor selection that keeps explicit mentioned files in their current deterministic path order and appends unique search-anchor files in ranked order. Carry the selected symbol IDs with the selection, use a file-diverse first pass in `collectPacketTargets`, and order `collectFollowUps` from the primary ranked anchor before secondary anchors, packets, and inherited follow-ups.

Remove `candidateTestsForAnchors`, `looksLikeTestFile`, and `normalizeStem`. Call `listCandidateTestFiles(snapshot.index, anchorFiles, anchorSymbolIds, { maxCandidates: snapshot.index.byFile.size, projectRoot: snapshot.root })`, expose only the capped file paths, and compute the existing omitted count from the full authoritative result without changing the response schema.

**Files and tests.** Modify `src/agent/explore.ts` and, only if needed to resolve selected symbol IDs without parsing display strings, `src/agent/search.ts` or `src/agent/handles.ts`. Add regression coverage in `tests/agent-explore.test.ts` for ranked natural-language anchor order, packet file diversity, primary-follow-up precedence, explicit-path behavior, and installer test selection; retain `tests/impact-context.test.ts` as the direct policy coverage for `listCandidateTestFiles`.

### PR 3: durable, threshold-free explore corpus

**Change.** Add an installer-preservation fixture under `tests/samples/benchmarks/` with the canonical preservation implementation, a directly related installer test, broad help text, generic MCP symbols, and intentionally tempting `realpathExisting` benchmark decoys. Extend the public explore benchmark contract in `docs/benchmarks/scenarios.json` with required anchor partial-order pairs, an expected recommended file, and required candidate-test files.

Update `scripts/benchmarks/run-scenario-lib.mjs` and `scripts/benchmarks/summarize-results-lib.mjs` to validate those exact reviewed relationships and record actual ranks and reciprocal ranks descriptively. Do not aggregate them into invented accuracy thresholds, top-k targets, or percentages.

**Files and tests.** Modify `docs/benchmarks/scenarios.json`, `scripts/benchmarks/run-scenario-lib.mjs`, and `scripts/benchmarks/summarize-results-lib.mjs`; add the fixture under `tests/samples/benchmarks/`. Extend `tests/public-docs-benchmarks.test.ts` for strict schema validation, path confinement, deterministic serialization, failed ordering/recommendation/candidate-test assertions, and successful execution through the existing public scenario harness.

## Migration and cache-version implications

This plan changes no public JSON schema and no persistent table columns. Bump the search ranking and query-index candidate versions wherever their values participate in result-cache or sidecar validation, and make stale derived data rebuild or fall back through the existing safe path rather than migrating rows in place.

The corpus must run both after a clean sidecar build and with the sidecar unavailable or disabled. If any versioned cache key is introduced for rank terms, it must include the parser/filter version so an old session cannot return a response ordered under a superseded contract.

## Risks and mitigations

- Prose filtering can hide a meaningful short word. Restrict it to multi-token natural-language classification, preserve identifier-like input and the all-filtered fallback, and cover both paths in tests.
- Candidate narrowing can create a sidecar-only false negative. Feed sidecar retrieval the same rank-bearing terms as fallback, verify candidates with the current matcher, and require corpus parity before accepting the change.
- Reordering composition can regress exact-path workflows. Keep explicit mentions and exact file-view resolution on their existing branch and exercise them beside natural-language cases.
- Direct candidate-test reuse can change broad low-confidence suggestions. That is intentional: preserve the authority's confidence/path ordering and verify direct installer-test coverage rather than reintroducing filename heuristics.

## Non-goals

- No vectors, embeddings, fuzzy ML, natural-language model calls, or learned scores.
- No directory allowlists, repository-specific rules, or installer-specific ranking boost.
- No changes to graph extraction, packet schema, MCP tool schema, CLI flags, source inclusion policy, or candidate-test policy itself.
- No numeric relevance, score, accuracy, latency, or candidate-count threshold as a correctness gate.

## Acceptance checks

- The installer-preservation corpus demonstrates that generic prose terms no longer dominate relevant anchors, packets, follow-ups, or candidate tests.
- Identical corpus input returns the same ordered handles, packets, candidate tests, and follow-ups through fresh library, MCP, valid-sidecar, and fallback paths.
- Explicit full paths, unique basenames, `--no-source`, result bounds, omission counts, and exact-file live views retain their existing contracts.
- `listCandidateTestFiles` is the only explore candidate-test selector, and the corpus includes the installer regression test without a directory-specific exception.
- Every changed ranking or candidate cache version is represented in cache-key/parity regression coverage.

## Definition of done

- [ ] PR 1 lands with deterministic natural-language rank terms and sidecar/fallback matcher parity.
- [ ] PR 2 lands with ranked explore composition and `listCandidateTestFiles` reuse.
- [ ] PR 3 lands with the durable installer-preservation corpus and threshold-free assertions.
- [ ] The fresh-session installer-preservation question leads to relevant installer anchors, a primary installer follow-up, and installer candidate-test coverage without a special-case boost.
