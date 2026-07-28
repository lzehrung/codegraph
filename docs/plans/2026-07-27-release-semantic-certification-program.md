# Release and semantic certification program

Status: Implemented

Parent review: [Project improvement review](./2026-07-27-project-improvement-review.md)

## Vision

A Codegraph release should be a proved artifact, not a successful publish command. Every shipped package must be secure, installable, loadable on its claimed target, and backed by measured semantic behavior on a pinned multilingual corpus.

This program combines release qualification, native-package smoke testing, semantic accuracy measurement, fixture hermeticity, and public benchmark publication. It creates one evidence chain from a source revision to the exact package tarballs and the claims made about them.

## Why this is one program

The current repository already has strong pieces:

- `.github/workflows/release.yml` builds every native target and refuses incomplete target artifacts.
- `scripts/check-native-artifacts.mjs` validates package structure before publication.
- `tests/native-semantic-parity.test.ts` checks selected native semantic behavior.
- `docs/benchmarks/` has versioned scenario and result contracts.
- `npm run check` covers formatting, lint, build, and the permanent test suite.

The missing property is composition. Structural artifact checks do not prove that packed packages install and execute, fixture tests do not quantify semantic accuracy, the public benchmark measures evidence retrieval rather than correctness, and the production dependency audit currently reports four known advisories.

A single certification envelope makes those distinctions explicit instead of allowing a green release job to imply more than it proved.

## Current measured baseline

Snapshot: `main` at `44de8b47` (`@lzehrung/codegraph` 1.8.103), Windows 11, Node.js 24.15.0, 2026-07-27.

- Repository check: 214 test files passed, 2,443 tests passed, 2 skipped.
- TypeScript coverage summary: 90.66% lines, 94.35% functions, 78.66% branches.
- Native coverage summary: 84.19% lines, 65.67% functions.
- Production audit: 4 advisories: 1 low, 2 moderate, 1 high.
- Direct affected dependency: `@modelcontextprotocol/sdk` 1.29.0 through `@hono/node-server`.
- Transitive affected dependencies: `body-parser`, `fast-uri`, and `@hono/node-server`.
- `npm outdated --json` reports a current `@modelcontextprotocol/sdk` release beyond the installed range.
- Release validation proves that target package files exist, but it does not install and execute the exact packed package set on each target host.
- `tests/samples/monorepo/.codegraph-cache/` can be left behind by failed or interrupted tests, which proves shared source fixtures are not fully hermetic.

Re-measure these values before implementation. They are planning baselines, not permanent thresholds.

## Outcomes

After this program:

1. Production dependency advisories are either zero or represented by an explicit, expiring, reviewed exception.
2. Release jobs build the exact tarballs once, certify those bytes, and publish those same bytes.
3. Every claimed executable native target has a host-runtime smoke result. A target without a real host is labeled unexecuted and cannot silently count as certified.
4. Definitions, references, graph edges, and candidate-test selection have published precision, recall, support, and latency results on pinned repositories.
5. Test suites cannot mutate checked-in fixtures or leave durable cache state under source fixtures.
6. Public claims link to a machine-readable result containing revision, package versions, target matrix, corpus revision, environment, and failure details.

## Non-goals

- Do not claim that a finite corpus proves universal correctness.
- Do not compare Codegraph to competitors in the first implementation.
- Do not make scheduled external-repository network availability a release blocker.
- Do not add telemetry to end-user commands.
- Do not replace the existing unit and integration suites with corpus tests.
- Do not publish a target as runtime-certified when CI only inspected its archive.
- Do not weaken native artifact checks or reduced-mode fallback behavior.

## Certification model

Use one versioned result envelope with independent sections. A release is qualified only when every required section has `status: "pass"`.

```ts
type CertificationReportV1 = {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    repository: string;
    revision: string;
    dirty: false;
  };
  versions: {
    root: string;
    native: string;
    node: string;
    rust?: string;
  };
  security: SecurityCertification;
  packages: PackageCertification[];
  semantics: SemanticCertification;
  hermeticity: HermeticityCertification;
  summary: {
    status: "pass" | "fail" | "incomplete";
    failures: CertificationFailure[];
  };
};
```

Every failure needs a stable code, a human message, and enough structured context to reproduce it. Do not represent an unexecuted check as a pass.

## Workstream A: production dependency security

### A1. Update and verify the MCP dependency chain

Start with the smallest supported update that clears the current advisories:

1. Update `@modelcontextprotocol/sdk` and regenerate `package-lock.json` with `npm install`.
2. Run the MCP stdio and Streamable HTTP suites, installer tests, package metadata tests, and `npm run check`.
3. Run `npm audit --omit=dev --json` against the resulting lockfile.
4. Confirm that HTTP host validation, loopback binding, request-size limits, and JSON body parsing behavior are unchanged.
5. If a major SDK update is required, use current SDK documentation and split API migration from the audit gate.

Do not use `npm audit fix --force`. The dependency update must be deliberate and reviewable.

### A2. Add a deterministic production-audit gate

Add:

- `scripts/check-production-audit.mjs`
- `scripts/security/production-audit-allowlist.json`
- unit tests for parser, severity policy, malformed audit output, and expired exceptions
- `npm run security:production`

The script runs `npm audit --omit=dev --json`, normalizes npm's nonzero exit behavior, and fails when any advisory is not covered by an active exception. The checked-in exception schema is:

```json
{
  "schemaVersion": 1,
  "exceptions": [
    {
      "advisory": "GHSA-...",
      "package": "package-name",
      "reason": "Why exposure is not reachable",
      "owner": "GitHub handle",
      "expires": "YYYY-MM-DD",
      "trackingIssue": "https://github.com/..."
    }
  ]
}
```

Exceptions must match advisory and package, must not be expired, and must never use wildcard IDs. The report records both accepted exceptions and rejected vulnerabilities so a green gate is still auditable.

Run this gate in on-demand CI and before release packaging. Keep development-only audit output separate; production release qualification must not be obscured by unrelated tooling advisories.

### A3. Security acceptance

- `npm audit --omit=dev --json` reports zero unexcepted advisories.
- No exception lacks owner, reason, issue, or expiry.
- A fixture containing an expired exception fails the script.
- A malformed npm audit response fails closed.
- MCP stdio and HTTP smoke tests pass against the updated dependency graph.

## Workstream B: certify exact package bytes

### B1. Build release candidates once

Refactor the release workflow into this DAG:

```text
plan release
  -> build native target directories
  -> assemble exact package versions
  -> npm pack every target, native meta-package, and root package
  -> upload immutable release-candidate artifact
  -> certify package matrix and semantics
  -> publish the already-certified tarballs
  -> create GitHub release from the same tarballs and report
```

The assembly job owns all temporary version edits. Downstream jobs consume tarballs and checksums, never rerun `npm pack` from independently modified directories.

Add a release-candidate manifest:

```ts
type ReleaseCandidateManifestV1 = {
  schemaVersion: 1;
  sourceRevision: string;
  rootVersion: string;
  nativeVersion: string;
  files: Array<{
    package: string;
    target?: string;
    file: string;
    sha256: string;
    size: number;
  }>;
};
```

Validate every downloaded file against this manifest before smoke testing or publishing.

### B2. Package smoke runner

Add reusable implementation under `scripts/certification/`:

- `package-contract-lib.mjs`: manifest validation, package selection, and result types
- `package-smoke-lib.mjs`: temporary installation and subprocess helpers
- `run-package-smoke.mjs`: CLI entry
- focused tests using tiny generated tarballs and mocked subprocess results

Each target smoke creates a fresh temporary directory outside the checkout and installs, in one npm invocation:

1. the target-specific native tarball,
2. the `@lzehrung/codegraph-native` meta-package tarball,
3. the root `@lzehrung/codegraph` tarball.

The explicit local tarballs must satisfy the scoped package names. Public production dependencies may come from npm, but the tested Codegraph packages must not come from a registry.

The runner verifies:

- installed package names and versions match the candidate manifest,
- installed Codegraph package files hash to the packed tarball contents,
- `import("@lzehrung/codegraph")` succeeds,
- `import("@lzehrung/codegraph-native")` selects the expected target package,
- `codegraph version` reports the candidate root version,
- `codegraph doctor` reports the expected native availability and target,
- `codegraph index` or `search` with `--native on` parses a tiny language fixture and returns a known symbol,
- one stdio MCP initialize/list-tools/search exchange succeeds from the packed binary,
- reduced mode still starts when the native package is intentionally omitted in a separate root-package smoke.

Capture stdout, stderr, exit code, duration, selected native path, and package identities. Bound captured output and redact tokens and registry credentials.

### B3. Runtime target matrix

Classify every native target as one of:

- `runtime`: executed on a matching OS and architecture,
- `emulated`: executed under an explicitly named emulator with limitations,
- `structural`: archive/package validated but not loaded,
- `unsupported`: intentionally not published.

Initial runtime jobs should use matching GitHub-hosted or repository-managed runners for macOS x64/arm64, Linux glibc x64/arm64, Linux musl x64/arm64, and Windows x64. Linux musl jobs run inside matching Alpine containers only when architecture matches.

Windows arm64 currently lacks a matching GitHub-hosted runner in this workflow. Choose one before calling it certified:

1. add a maintained Windows arm64 self-hosted runner,
2. prove the addon under a suitable emulator and label the result `emulated`, or
3. keep publication behind a reviewed `structural-only` exception with owner and expiry.

The workflow must not map cross-compilation success to runtime success.

### B4. Release workflow enforcement

The publish job requires:

- security report pass,
- all required package smoke rows pass,
- candidate manifest checksum pass,
- source revision still equals the planned revision,
- no missing target artifacts,
- package versions match the release plan,
- semantic release-gate suite pass.

Use GitHub artifact IDs and SHA-256 checksums in the final report. Publishing must stop before the first registry write if any required row is incomplete.

### B5. Package acceptance

- A deliberately wrong native target fails with a stable target-mismatch code.
- A modified tarball fails before installation.
- A package that imports but cannot parse fails runtime certification.
- The MCP smoke uses the packed bin, not `src/` or the checkout's `dist/`.
- The GitHub release attaches the exact checksums that passed certification.

## Workstream C: semantic quality corpus

### C1. Two-tier corpus

Use two tiers with the same schema:

1. `release`: small checked-in fixtures, deterministic, no network, blocks every release.
2. `representative`: pinned public repositories, scheduled and manually runnable, publishes quality trends after stabilization.

External repository availability must not block a release. The scheduled job clones immutable revisions into a cache, verifies the resolved commit, and records clone provenance. A later PR may promote a mirrored, license-compatible snapshot into the release tier after repository size and licensing review.

### C2. Corpus manifest

Add `docs/benchmarks/semantic-corpus.json` with this contract:

```ts
type SemanticCorpusV1 = {
  schemaVersion: 1;
  corpusRevision: string;
  repositories: Array<{
    id: string;
    url: string;
    revision: string;
    license: string;
    includeRoots?: string[];
    config?: string;
  }>;
  cases: Array<{
    id: string;
    tier: "release" | "representative";
    repository: string;
    language: string;
    operation: "definition" | "references" | "dependency" | "candidate-tests";
    request: Record<string, unknown>;
    expected: {
      required: SemanticLocation[];
      allowed?: SemanticLocation[];
      forbidden?: SemanticLocation[];
      unsupported?: string;
    };
    rationale: string;
  }>;
};
```

The manifest is data only. Do not allow arbitrary shell commands, environment expansion, absolute paths, or repository-relative traversal.

Select repositories using explicit criteria:

- permissive license and stable public history,
- realistic package/module structure,
- at least two languages from Codegraph's claimed native set,
- manageable checkout and index size,
- constructs that exercise imports, re-exports, inheritance, generated declarations, tests, and framework conventions,
- no secrets or large binary assets required for the selected include roots.

Start with 3-5 repositories and 15-25 reviewed cases per operation. Expand only when a new case covers a known semantic class rather than inflating counts.

### C3. Goldens and oracle process

Goldens are reviewed repository facts, not snapshots of Codegraph output.

For each case:

1. derive candidates with the language's compiler, LSP, or repository search,
2. review the source at the pinned revision,
3. record required, allowed, and forbidden locations,
4. explain ambiguity in `rationale`,
5. require a second reviewer for golden changes.

Store file paths and ranges relative to the pinned repository root. Use symbol handles only as requests, never as the golden identity, because handles are implementation output.

### C4. Scoring

Use exact, documented denominators:

- A required location returned is a true positive.
- A required location omitted is a false negative.
- A returned location listed as forbidden is a false positive.
- Allowed locations are neutral.
- Unexpected returned locations require triage; once classified, update the golden in the same review.
- Unsupported cases count against support rate and are excluded from precision/recall only when the public table displays the support denominator beside those metrics.

Report per operation, language, repository, runtime mode, and total:

```text
support = supported cases / all cases
precision = true positives / (true positives + false positives)
recall = true positives / (true positives + false negatives)
F1 = harmonic mean of precision and recall
latency = p50, p95, and max per operation
```

For dependency edges, compare normalized project-relative `(from, to, kind)` tuples. For candidate tests, score required and forbidden test files and report mean reciprocal rank for the first required test.

Never collapse reduced and native modes into one quality number.

### C5. Runner and result files

Add:

- `scripts/benchmarks/run-semantic-corpus.mjs`
- `scripts/benchmarks/semantic-corpus-lib.mjs`
- `scripts/benchmarks/summarize-semantic-corpus.mjs`
- tests for schema validation, path confinement, scoring, unsupported cases, duplicate results, and deterministic ordering
- `docs/benchmarks/semantic-results.example.json`

The runner invokes published/library contracts where practical:

- `goto`/definition API for definitions,
- `refs`/references API for references,
- normalized project graph for dependencies,
- impact/review candidate tests for test selection.

Run release-tier cases against the exact packed root and native packages. Representative scheduled runs may use the built checkout, but their report must identify that package mode distinctly.

### C6. Initial quality gates

Do not invent thresholds before the first reviewed baseline. Land in this order:

1. schema and runner with informational output,
2. manually review all goldens,
3. publish three consecutive stable runs,
4. set release gates to prevent regression from the accepted baseline,
5. set absolute minimums only after known unsupported classes are documented.

The first blocking policy should be:

- release-tier support, precision, and recall cannot decrease,
- no previously passing case may regress without an approved golden or limitation update,
- runtime mode cannot silently change from native to reduced,
- p95 latency may not regress more than 20% without an attached benchmark explanation.

## Workstream D: fixture hermeticity

### D1. Isolate mutable state

No test may run a cache-writing command directly against a checked-in fixture directory. Introduce one helper that:

1. creates a unique temporary directory,
2. copies the required fixture subset,
3. runs the test against the copy,
4. removes it in `finally`,
5. reports the retained temporary path only when an explicit debug environment variable is set.

Migrate workspace, lifecycle, cache, benchmark, and installer tests that can write `.codegraph`, `.codegraph-cache`, package locks, config files, or generated artifacts.

Tests that only read immutable samples may continue reading them in place. Make that distinction explicit in helper names.

### D2. Add a post-suite cleanliness gate

Add `scripts/check-fixture-cleanliness.mjs` and run it after tests in CI and `npm run check`. It fails on:

- `.codegraph/` or `.codegraph-cache/` below checked-in fixture roots,
- generated package locks not committed as fixture input,
- benchmark outputs outside approved result paths,
- modified tracked fixture files,
- known temporary naming patterns.

The script must be cross-platform and use Node APIs, not shell-specific `find` or `git clean`. CI may additionally use `git diff --exit-code` as defense in depth.

### D3. Hermeticity acceptance

- A test that intentionally writes a cache into `tests/samples/` is caught.
- An interrupted test leaves state only under the OS temporary root.
- Two concurrent test workers receive different fixture copies.
- Running the full suite twice leaves an identical checkout.
- The certification report records the cleanliness result.

## Public report and documentation

Extend `docs/benchmarks/README.md` with a semantic certification section that states exactly what is and is not measured. Publish a machine-readable report as a workflow artifact first; commit curated results only through reviewed pull requests.

Update these canonical surfaces when implementation changes behavior:

- `README.md`: concise trust claim and links only
- `docs/installation.md`: certified package/target meaning
- `docs/language-parity.md`: measured support and intentional limitations
- `docs/scenario-catalog.md`: fixture and corpus coverage
- `docs/benchmarks/README.md`: methodology and result schema
- `PUBLISHING.md`: certification gate and release-candidate byte flow
- `codegraph-skill/codegraph/SKILL.md`: only if CLI commands or flags change

Do not publish a single "accuracy" percentage without operation, runtime mode, support denominator, corpus revision, and date.

## Implementation sequence and pull requests

### PR 1: security and hermetic baseline

- update the MCP SDK dependency chain,
- add the production audit gate,
- add fixture-copy helper and cleanliness gate,
- migrate known mutating tests,
- keep release behavior otherwise unchanged.

Exit: zero unexcepted production advisories and two clean consecutive full-suite runs.

### PR 2: immutable release candidates

- assemble and checksum exact tarballs once,
- add package smoke runner,
- run existing host-executable target rows,
- publish only certified tarballs.

Exit: Windows x64, Linux glibc/musl, and macOS rows execute packed CLI, native parse, and MCP smoke; unexecuted targets are explicit.

### PR 3: semantic corpus contract

- add manifest, validators, runner, and release fixture tier,
- add informational report to CI,
- document scoring.

Exit: deterministic report on repeated runs and manually reviewed goldens.

### PR 4: representative corpus and gates

- add pinned public repositories,
- run scheduled matrix,
- publish first baseline,
- add non-regression thresholds after three stable runs.

Exit: public report can be regenerated from documented commands and pinned inputs.

## Required tests

- production audit JSON parsing and exception expiry
- release candidate checksum and package identity validation
- target mismatch and native load failure
- packed CLI version, doctor, parse, and MCP round trip
- corpus schema rejection for traversal and arbitrary commands
- deterministic semantic scoring and ordering
- duplicate/allowed/forbidden location handling
- native versus reduced result separation
- fixture copy isolation and concurrent cleanup
- release workflow contract tests for required jobs and artifact handoff

Use the narrowest relevant suites during implementation, then run `npm run check` before each PR concludes. For workflow-only changes, also execute the reusable scripts locally with synthetic artifacts and validate the workflow YAML paths.

## Risks and mitigations

### External repository drift

Pinned commits can disappear or repositories can become unavailable. Record resolved commits, cache clones, and keep external runs scheduled rather than release-blocking.

### Golden bias

Codegraph-generated output can accidentally become the oracle. Require source rationale and second review for golden changes.

### Cross-target blind spots

Cross-compilation looks green without executing. Preserve `runtime`, `emulated`, and `structural` as separate states and block unsupported claims.

### Release duration

Native builds already dominate the workflow. Run package smokes in parallel after one assembly job and keep the release semantic tier intentionally small.

### Security exception permanence

Allowlist entries tend to live forever. Require expiry and fail closed on expired rows.

### Flaky latency gates

Hosted runners vary. Use repeated samples, compare to a same-job baseline where possible, and gate large regressions rather than millisecond noise.

## Definition of done

- [x] No unexcepted production advisory remains.
- [x] Exact candidate tarballs are assembled once and checksummed.
- [x] Published bytes equal certified bytes.
- [x] Every published native target has an explicit runtime/emulated/structural state.
- [x] Required runtime rows pass library, CLI, native parse, and MCP smoke tests.
- [x] Release and representative semantic corpus tiers exist with reviewed goldens.
- [x] Precision, recall, support, and latency are reported by operation and runtime mode.
- [x] Checked-in fixtures remain unchanged after repeated and concurrent suites.
- [x] Release workflow blocks incomplete certification.
- [x] Public docs state the scope and limits of every claim.
- [x] `npm run check` passes.
