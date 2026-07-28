# Project improvement review

Date: 2026-07-27  
Reviewed revision: `8bad0a98` (`v1.8.103`)  
Primary environment: Windows 11, Node.js 24.15.0

## Executive recommendation

Do three cross-cutting programs, not a long list of isolated fixes.

| Rank | Program                                                                                             | Severity | ROI       | Primary result                                                                                                    |
| ---: | --------------------------------------------------------------------------------------------------- | -------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
|    1 | [Release and semantic certification matrix](./2026-07-27-release-semantic-certification-program.md) | S0       | Very high | Every published package is secure, loadable on its target, and backed by measured semantic quality.               |
|    2 | [Persistent query substrate](./2026-07-27-persistent-query-substrate.md)                            | S1       | Very high | Search and agent queries stop rescanning the repository and return compact results within an interactive budget.  |
|    3 | [One-command product funnel](./2026-07-27-one-command-product-funnel.md)                            | S1       | Very high | A new user can install, understand, configure, and prove value without registry knowledge or command archaeology. |

These programs cover performance, stability, correctness, usability, and marketability with shared infrastructure. They also absorb most unfinished roadmap work that still has a strong user outcome.

## Severity and ROI rubric

- **S0 - release blocker:** known security exposure, unverified shipped binaries, or a defect that can invalidate trust in a release.
- **S1 - material product problem:** common workflows are slow, fail, mislead, or impose enough friction to lose users.
- **S2 - maintainability drag:** raises future defect cost but does not currently block the primary workflow.
- **Very high ROI:** one shared change removes several high-value problems or creates reusable evidence.
- **High ROI:** a focused change materially improves one core workflow.
- **Low ROI:** measurable work with little effect on adoption, answer quality, or operational risk.

## What should be preserved

The project already has a stronger technical core than its adoption signals suggest.

- `inspect ./src` found 342 TypeScript files, zero unresolved project imports, and zero dependency cycles.
- Startup work succeeded: warm medians were 45 ms for `--version`, 47 ms for `--help`, 59 ms for `doctor`, and 506 ms for `orient --budget small --json`.
- Current JavaScript coverage is 90.66% of lines, 94.35% of functions, and 78.66% of branches. Native coverage documentation reports 96.49% of Rust lines.
- The README states limitations instead of presenting Tree-sitter heuristics as compiler truth (`README.md:286-297`).
- Agent responses expose provenance, limits, omission counts, and copyable follow-ups. That is a credible differentiator worth keeping.
- The codebase has no dependency cycle that justifies a broad architecture rewrite. High fan-in type and path modules are expected foundations, not evidence of a defect.

## Evidence summary

| Observation                                                                                                                     | Direct evidence                                                                                                        | Consequence                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Production dependencies have one high, two moderate, and one low advisory.                                                      | `npm audit --omit=dev --json` on 2026-07-27.                                                                           | Release trust is currently below the standard implied by a local security-sensitive MCP tool.            |
| Primary CI runs only on Ubuntu and Node 22.16.                                                                                  | `.github/workflows/on-demand-ci.yml:10-38`                                                                             | Windows and macOS behavior can regress between releases.                                                 |
| Release jobs build eight native targets but do not load or parse with the resulting artifacts.                                  | `.github/workflows/release.yml:51-136`                                                                                 | A successful build can still publish an unloadable or incorrectly staged binary.                         |
| Warm hybrid CLI search took 2.46-2.98 seconds on this repository.                                                               | Five-run and three-run local samples.                                                                                  | The default search path remains outside an interactive agent budget.                                     |
| A first MCP hybrid search took 20.5 seconds; repeated calls took 1.14-1.18 seconds.                                             | Three calls through the live MCP device.                                                                               | Cold or invalidated sessions feel stalled, and even warm queries remain expensive.                       |
| Three MCP search results serialized about 26 KiB.                                                                               | Live MCP search response.                                                                                              | The tool spends agent context on repeated evidence, neighbors, and follow-ups.                           |
| Hybrid search scans every snapshot file sequentially for text.                                                                  | `src/agent/search.ts:597-640`                                                                                          | Query cost is proportional to repository size even when few files can match.                             |
| Search caches are keyed only by an in-memory snapshot object.                                                                   | `src/agent/search.ts:683-725`                                                                                          | Fresh CLI processes cannot reuse normalized text or chunks.                                              |
| Running `codegraph` with no arguments emitted a 93,635-byte Mermaid graph.                                                      | Direct CLI smoke. `src/cli.ts:141-143` defaults to `graph`.                                                            | The first-run experience performs expensive work and hides the intended `orient`/`explore` entry points. |
| A mistyped command returned only `Unknown command: serach`.                                                                     | Direct CLI smoke.                                                                                                      | Users get no correction or next action.                                                                  |
| Top-level help exposes 42 commands and 46 usage lines.                                                                          | Parsed `--help` output.                                                                                                | Powerful primitives dominate the front door instead of the five workflows most users need.               |
| Published installation requires Node 22.16 and either GitHub Packages configuration or a root tarball without native semantics. | `README.md:51-82`, `docs/installation.md:40-72`                                                                        | The easiest install path is not the full product.                                                        |
| Checked documentation benchmarks explicitly do not measure answer quality, relevance, correctness, tokens, or general speed.    | `docs/benchmarks/README.md:5-11`, `:73-80`                                                                             | The project cannot yet turn its strongest design claims into comparative proof.                          |
| Source samples cover many languages but remain small.                                                                           | 303 source fixture files totaling 49,664 bytes; language samples total 5,499 bytes.                                    | Unit breadth is strong, but ecosystem-scale resolution behavior is not certified.                        |
| Roadmap status is stale and fragmented.                                                                                         | 31 plan files; many have no status, and the performance index still says `Planned` while recording shipped priorities. | Maintainers and users cannot distinguish shipped, superseded, and next work reliably.                    |
| The only open PR is a dirty draft based on an old feature branch.                                                               | PR [#146](https://github.com/lzehrung/codegraph/pull/146)                                                              | The public backlog does not represent an executable current roadmap.                                     |

## 1. Release and semantic certification matrix

Implementation plan: [Release and semantic certification program](./2026-07-27-release-semantic-certification-program.md)

**Severity: S0**  
**ROI: Very high**  
**Dimensions: stability, correctness, security, marketability**

### Problem

The current release process proves that code builds on Ubuntu and that native artifacts can be produced. It does not prove that every published artifact loads on its host, that the installed package selects it correctly, or that the advertised semantic operations remain accurate on representative repositories.

The production dependency audit reported:

- `fast-uri`: high-severity host-confusion advisories [GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx) and [GHSA-4c8g-83qw-93j6](https://github.com/advisories/GHSA-4c8g-83qw-93j6).
- `@modelcontextprotocol/sdk` through `@hono/node-server`: moderate Windows encoded-backslash traversal advisory [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9).
- `body-parser`: low-severity limit-enforcement denial of service advisory [GHSA-v422-hmwv-36x6](https://github.com/advisories/GHSA-v422-hmwv-36x6).

Actual exploitability through Codegraph's custom Node HTTP path is not established. The safe action is to update, verify reachability, and gate future releases rather than infer that transitive code is unreachable.

### One cross-cutting change

Create one manifest-driven certification runner used by pull requests, release jobs, scheduled quality runs, and the public benchmark report.

1. **Dependency policy**
   - Update `@modelcontextprotocol/sdk` and the lockfile to patched transitive versions.
   - Fail release qualification on unreviewed production advisories.
   - Allow exceptions only with package, advisory, reachability evidence, owner, and expiry recorded in one machine-readable allowlist.

2. **Install and runtime matrix**
   - Pack the exact root, native meta, and target packages that will be published.
   - Install them into clean temporary projects on Windows, Linux glibc, Linux musl, and macOS runners where executable hosts exist.
   - Require `doctor`, `--version`, `orient`, one native parse, and one MCP request to succeed from the packed artifacts.
   - Verify that `doctor` reports the expected package version, native target, loaded path, and reduced-mode reason where native is intentionally unavailable.
   - Make publishing depend on these tests, not only on artifact creation.

3. **Semantic corpus**
   - Define pinned repository revisions and task manifests for the most important ecosystems: TypeScript, Python, Go, Rust, Java/Kotlin, C/C++, C#, PHP, SQL, and mixed monorepos.
   - Keep ordinary PR tests network-free. Run the pinned external corpus in scheduled and release qualification jobs, with a small committed regression subset for every discovered defect.
   - Compare go-to-definition, references, hierarchy, call edges, imports, and candidate tests against compiler/LSP results where an authoritative provider exists.
   - Track precision, recall, unsupported cases, parse degradation, fallback use, latency, peak memory, and output bytes by language and operation.

4. **Hermetic tests**
   - Give every test a private project copy and cache root.
   - Prohibit writes to shared source fixtures.
   - Add a post-suite assertion that fixture trees and tracked files did not change.

During the preceding full check, `workspace-detection.test.ts` transiently failed while copying a `.codegraph-cache` temporary manifest from a shared sample tree. The isolated rerun and a clean full rerun passed, which makes fixture isolation the correct fix rather than a retry policy.

### Acceptance gate

- `npm audit --omit=dev` has no unreviewed advisory.
- Every executable release target installs from packed artifacts, loads the intended native binary, and completes the same smoke scenario.
- No release artifact is published before its target smoke passes.
- The corpus publishes versioned quality and latency results with exact repository revisions.
- Every supported semantic capability has a stated measured denominator, not only a representative happy-path fixture.
- Repeated full-suite runs leave shared fixtures unchanged and do not depend on test ordering.

### Why this is one program

The same matrix produces release confidence, semantic regression protection, and credible public proof. Separate security, cross-platform, accuracy, and benchmark projects would duplicate package staging, fixture provisioning, result schemas, and reporting.

## 2. Persistent query substrate

Implementation plan: [Persistent query substrate](./2026-07-27-persistent-query-substrate.md)

**Severity: S1**  
**ROI: Very high**  
**Dimensions: performance, stability, correctness, usability**

### Problem

Startup is no longer the dominant cost. The query layer still rebuilds searchable state and scores repository-wide candidates on each fresh process.

Measured on the reviewed repository:

| Operation                                       |       Result |
| ----------------------------------------------- | -----------: |
| `--version` warm median                         |        45 ms |
| `doctor` warm median                            |        59 ms |
| `orient --budget small --json` warm median      |       506 ms |
| CLI hybrid search, `--limit 3`                  |  2.46-2.98 s |
| CLI symbol search                               |       1.03 s |
| CLI path search                                 |       428 ms |
| CLI text search                                 |       2.26 s |
| First live MCP hybrid search after invalidation |       20.5 s |
| Repeated live MCP hybrid search                 |  1.14-1.18 s |
| MCP payload for three results                   | about 26 KiB |

`addTextResults` awaits normalized text for every file, one file at a time (`src/agent/search.ts:597-640`). The `WeakMap` cache helps repeated queries against the same in-memory snapshot, but it cannot help a new CLI process and it still leaves repository-wide matching work on every query (`src/agent/search.ts:683-725`).

### One cross-cutting change

Add one versioned, immutable query sidecar keyed by the existing project snapshot identity.

1. **Persist query-ready data once**
   - Store normalized file text, semantic chunks, token postings, path tokens, symbol lookup keys, and file/symbol adjacency.
   - Use a dedicated `search-v1` sidecar so search evolution does not inflate or destabilize the core project snapshot.
   - Write atomically and record the exact runtime, discovery, include-root, graph-option, and source identities that already govern cache validity.

2. **Update incrementally**
   - Rebuild rows only for added, changed, retired, or explicitly supplied transient files.
   - Treat deletions as invalidation events before removing their old dependency evidence.
   - Keep `--root`, include roots, CLI globs, config globs, native identity, and reduced-mode identity in the cache key.

3. **Retrieve candidates before scoring**
   - Use postings to select a bounded candidate set.
   - Preserve the current deterministic ranking and provenance logic over that set.
   - Do not delegate ranking to an opaque database relevance score.

4. **Share it across surfaces**
   - CLI, library sessions, MCP, `search`, `explore`, packets, and source-snippet retrieval must consume the same query snapshot.
   - Cache file and symbol neighbor indexes once per query snapshot instead of rebuilding them per request.

5. **Make response detail explicit**
   - Add compact, standard, and full detail levels to search/explore response construction.
   - Keep handles, provenance, limits, and omission counts in compact mode.
   - Avoid repeating neighbors, follow-ups, and snippets when the caller requested only a few ranked anchors.

6. **Profile remaining cache work after this lands**
   - Finish native fingerprint avoidance, worker reuse, and cache pruning only where the new profile still shows material cost.
   - Retire or update the July 25 performance plans instead of maintaining parallel descriptions of the same budget.

### Acceptance gate

Use the existing performance-program hardware and command definitions, then record p50 and p95:

- Warm CLI hybrid search on this repository is at or below the existing 700 ms target.
- Warm MCP search is below 200 ms for a three-result query.
- A valid persisted snapshot does not trigger a full repository text read.
- Cold or invalidated MCP work reports progress before the client timeout and completes without a 30-second request failure.
- Compact three-result search output is below 8 KiB while retaining handles, provenance, limits, and omissions.
- Golden relevance results do not regress on the certification corpus.
- Corrupt, stale, partial, or incompatible sidecars fail closed to a rebuild with a diagnostic, never to stale answers.

### Why this is one program

A daemon, another startup pass, and isolated micro-caches would attack symptoms. One query snapshot removes repeated I/O, repeated normalization, repeated graph-index construction, response bloat, and CLI/MCP behavioral drift together.

## 3. One-command product funnel

Implementation plan: [One-command product funnel](./2026-07-27-one-command-product-funnel.md)

**Severity: S1**  
**ROI: Very high**  
**Dimensions: usability, marketability, supportability**

### Problem

The product's strongest workflow is hidden behind installation and command-discovery friction.

- Bare `codegraph` builds and prints a full graph instead of explaining the product.
- Help exposes 42 commands even though README onboarding centers on `explore`, `orient`, `review`, `impact`, and `install`.
- Unknown commands provide no suggestion.
- The full native product requires GitHub Packages configuration. The registry-free release tarball installs only the reduced semantic mode unless the registry is configured separately.
- Node 22.16 is a hard prerequisite.
- The public repository has 2 stars and no open issues. Stars are not a quality metric, but they are a direct discoverability signal.

The category is crowded and sets a much lower-friction expectation:

- [oraios/serena](https://github.com/oraios/serena): 27,019 stars; positions itself as semantic retrieval and editing for agents.
- [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp): 35,853 stars; leads with a persistent graph, a single static binary, and zero dependencies.
- [abhigyanpatwari/GitNexus](https://github.com/abhigyanpatwari/GitNexus): 44,691 stars; leads with a browser-based interactive graph and immediate visual demo.

[INFERENCE] Codegraph should not compete on the largest language count, a generic graph screenshot, or compiler-grade editing. Its defensible story is deterministic local evidence for agents: bounded source, explicit omissions, conservative semantics, and diff-aware impact/review.

### One cross-cutting change

Design one acquisition-to-proof path and make every public surface reinforce it.

1. **Frictionless distribution**
   - Ship signed per-platform GitHub Release archives containing the CLI runtime and matching native addon.
   - Keep the package/library channel for TypeScript consumers, but do not require registry configuration for the primary CLI trial.
   - Add platform-native install wrappers only after the same standalone artifact passes the certification matrix.
   - Implement a real `upgrade` only when the channel can update itself safely: confirmation unless `--yes`, streamed subprocess output, exit propagation, resulting-version verification, dirty/detached source-tree refusal, permission handling, and Windows mapped-runtime safety.

2. **Opinionated first run**
   - Bare `codegraph` prints a concise explanation plus `doctor`, `orient`, `explore`, `review`, and `install` next actions. It must not scan the repository.
   - Unknown commands suggest the nearest valid command and show its short usage.
   - `codegraph install --detect --yes` becomes the single agent-configuration path; keep dry-run and ownership-safe uninstall.
   - Group low-level commands under an advanced help section without removing scriptable primitives.

3. **One product claim with proof**
   - Lead with: "Give an agent bounded, local evidence for where code lives and what a change can break."
   - Publish certification-corpus results for answer quality, latency, output bytes, and unsupported cases.
   - Add one short end-to-end demonstration: install, ask an architecture question, inspect cited source, review a diff, and select tests.
   - Compare workflows, not raw feature counts. Show where Codegraph is more conservative and where a compiler/LSP remains authoritative.

4. **One live roadmap**
   - Replace status inference across 31 plan files with one index containing `shipped`, `next`, `blocked`, and `superseded` states.
   - Keep historical plans, but require each to point back to the current index and name the release or PR that changed its state.
   - Resolve PR #146 explicitly against current `main`: re-scope/reimplement the user outcome or mark it superseded. Do not preserve its 38-file stale stack merely because work already exists.
   - Stop adding commands until the front door and certification data show a missing workflow rather than a missing primitive.

### Acceptance gate

- A fresh supported machine reaches native `doctor: available` and a useful `orient` result from one documented install command.
- Bare `codegraph` completes without repository discovery and emits less than 3 KiB.
- A one-edit typo such as `serach` suggests `search`.
- Top-level help presents no more than five primary workflows before advanced commands.
- The README trial path is install, verify, ask; registry and native-package internals move to installation reference material.
- Published benchmark pages include quality, latency, output-size, corpus revision, and known-limit data generated by the certification runner.
- Every active roadmap item has one status and one owning issue or PR.

### Why this is one program

Distribution, first-run behavior, setup, proof, and roadmap focus are one funnel. Improving only README wording cannot overcome an authenticated install, a 93 KiB no-argument response, or absent quality evidence.

## Severity and ROI-ranked findings within the programs

| Order | Finding                                                                      | Severity | ROI if addressed through the program |
| ----: | ---------------------------------------------------------------------------- | -------- | ------------------------------------ |
|     1 | Unreviewed production dependency advisories                                  | S0       | Very high                            |
|     2 | Native release artifacts are built but not executed before publish           | S0       | Very high                            |
|     3 | CI lacks Windows and macOS product-path coverage                             | S0       | Very high                            |
|     4 | Hybrid search remains 2.46-2.98 seconds and scales with repository files     | S1       | Very high                            |
|     5 | Cold MCP query work can exceed the 30-second request budget                  | S1       | Very high                            |
|     6 | Full MCP search responses spend about 26 KiB on three results                | S1       | High                                 |
|     7 | Full native install requires registry-specific knowledge                     | S1       | Very high                            |
|     8 | Bare CLI invocation emits a repository graph                                 | S1       | Very high                            |
|     9 | Public benchmarks do not measure semantic quality or token/output efficiency | S1       | Very high                            |
|    10 | Broad language claims rely mostly on small fixtures                          | S1       | Very high                            |
|    11 | Forty-two CLI commands dilute the primary workflows                          | S2       | High                                 |
|    12 | Stale plan state and one dirty draft PR obscure priorities                   | S2       | High                                 |
|    13 | Root compatibility surface and internal exports are broad                    | S2       | Low until adoption grows             |

## Recommended sequence

1. Land the production dependency updates and release-audit gate first.
2. Add packed-package smoke tests to existing target runners before changing distribution.
3. Define the certification result schema and a small multi-language corpus.
4. Build the persistent query sidecar against that corpus so speed work cannot silently trade away relevance or freshness.
5. Switch CLI/MCP search and explore to the shared query snapshot and compact response levels.
6. Change the no-argument/unknown-command front door.
7. Publish standalone artifacts only after target certification passes.
8. Publish the quality/latency scorecard and rewrite positioning from those results.
9. Reconcile roadmap status and decide PR #146 against the now-measured priorities.

## Explicitly defer

These are lower ROI than the three programs above:

- More language count before existing semantic claims have corpus-level precision and recall.
- A broad internal module refactor; current source inspection reports zero dependency cycles.
- More startup-only work; lightweight commands are already 45-59 ms warm.
- A new graph UI before install and first-query friction are solved.
- More CLI commands, including `affected`, until the existing impact/review workflow is measured against real user tasks.
- A breaking cleanup of the root TypeScript export surface. Document and freeze it first; narrow only with real consumer evidence.
- Telemetry by default. Reproducible local diagnostics and opt-in benchmark artifacts fit the privacy position better.

## Method and limitations

The review used current source, documentation, GitHub state, runtime experiments, coverage, dependency audit, and Codegraph's own structural reports.

Commands and experiments included:

- `doctor`, `orient`, and `inspect ./src`
- repeated CLI timing for version, help, doctor, orient, inspect, and each search mode
- live MCP cold and warm search timing
- CLI error-path and no-argument output sampling
- `npm run test:coverage`
- `npm audit --omit=dev --json`, full `npm audit --json`, and `npm outdated --json`
- `npm pack --dry-run --json`
- fixture, command, plan-status, CI, release, and public API inventories
- current GitHub repository, PR, issue, and competitor repository metadata

Limits:

- Performance numbers are local Windows samples, not universal claims.
- The review did not run a controlled agent A/B study; that is a deliverable of the certification matrix.
- Competitor stars and repository descriptions measure visibility and positioning, not technical correctness.
- Codegraph's self-inspection was paired with source reads and runtime evidence, but it is not an independent oracle for Codegraph's semantic accuracy.

## Bottom line

The project does not need more breadth first. It needs release-grade trust, a genuinely persistent query path, and a first-run story that exposes the value already present.

Those three programs turn the existing engineering strengths into a product that is faster to trust, faster to try, and easier to differentiate.
