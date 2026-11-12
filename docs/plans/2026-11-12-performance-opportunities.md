# Performance opportunities

Status: Planned. Work these items between language-accuracy batches. Measurement-only work stays in
[the measurement backlog](2026-08-03-performance-measurement-backlog.md).

## Rules for every item

- Measure base and head as `AGENTS.md` requires: separate processes, at least five alternating
  rounds, pinned `threads` and `nativeThreads`, medians with spread, on large real projects.
- Cover every affected operation: `codegraph init`, cold index build, no-change update, one-file
  update, detailed graph build, search, references, and go-to-definition.
- An optimization must not change any answer. Prove it with a differential of detailed-graph edges,
  go-to-definition, and references (including coverage) over `tests/samples`, `tests/edge-corpus`,
  and the benchmark projects: zero differences.
- Record the before/after medians in this file when an item lands.

## Measurement

- [ ] Commit a paired base/head benchmark command that covers all eight operations above, alternates
      the run order each round, and reports median, spread, rounds where head was slower, and the
      regression verdict. The accuracy batches used an uncommitted version of this harness.
- [ ] Pin a real-project corpus per language family (repository URL and commit), reusing the
      accuracy benchmark manifest where possible.
- [ ] Profile `main` on each operation and corpus, and record the top self-time functions here so
      the items below can be ranked by measured cost.

## Opportunities

Each item comes from a cost found and fixed in one language during the accuracy batches. The same
pattern likely exists elsewhere.

- [ ] **Gate language-specific work in shared passes.** The PHP accuracy fixes built PHP trait state
      for every index; on the TypeScript-only Hono project this added 8.7 ms of self time to
      `buildSymbolGraphDetailed` (graph build +2.2%) until it was gated on PHP being present. Audit
      `symbol-graph-detailed.ts`, `edge-passes.ts`, `receiver-calls.ts`, `member-selection.ts`,
      `navigation-goto.ts`, and `locals-and-exports.ts` for setup that runs regardless of the
      languages in the index or module.
- [ ] **Cache owner, ancestor, and member facts per index for every language.** Swift owner proofs
      recomputed per call cost 319 ms of self time in the Kingfisher graph build (+5.6%) before a
      per-index cache. Ruby on RuboCop: `collectType` 81 to 8 ms, `rubyEnclosingNamespaces` 49 to
      4 ms, `rubyConstantRoot` 44 to 1.5 ms, `resolveSharedOwnerContainers` 26 to 8 ms after
      caching. `resolveSharedOwnerContainers` is shared; check the Kotlin, Java, TypeScript,
      Python, C++, and PHP paths for per-call recomputation (C# already warms owner chains).
- [ ] **Keep every name on the Bloom prefilter.** Ruby names ending in `?`, `!`, or `=` failed the
      Bloom token check, so each references query scanned all 2,248 RuboCop modules (2.1 s to
      117 ms after normalizing the name first). Count full-scan fallbacks per language on the
      corpora and normalize Kotlin and Swift backtick names, C# `@` names, and PHP case-folded
      names the same way.
- [ ] **Index identifier spellings once per parsed tree.** Indexing Ruby send names once per tree
      cut `rubyMethodName` from 13.3 to 1.5 ms in reference queries. Share one name-to-nodes index
      per tree across references, rename preview, call hierarchy, and the detailed graph.
- [ ] **Size the native worker pool by project size.** Cold builds start up to eight native
      extraction workers regardless of file count. Measure worker startup against extraction work
      for 100 to 500 file projects and for `codegraph init`, and choose the pool size from the
      file count.
- [ ] **Count Git processes per operation.** Incremental fixes in #523 and #529 showed per-update Git
      listing and stat passes as visible costs (an end-of-line stat pass alone added 185 to 467 ms
      per unchanged update on a 10,000-file repository before it was removed). Count spawned Git
      processes for init, updates, and queries, then batch or reuse their results.
- [ ] **Profile `codegraph init`.** A cold `init` on a 651-file project measured a 3,788 ms median on
      3.2.0 versus 3,390 ms on 3.1.3 (three alternating runs, about 12% slower). The cause is
      unconfirmed; candidates are lifecycle root discovery, incremental Git checks, and new
      per-file facts.
- [ ] **Bound graph-build cost per resolved edge.** After caching, the Ruby fixes still add about 8%
      correct edges on RuboCop (21,621 to 23,286); track graph-build time per edge so new
      resolution rules do not grow cost faster than the edges they add.
- [ ] **Measure repeated search.** No search cost has been measured in these batches yet; start
      from the "Repeated search" item in the measurement backlog.
