# Public docs and benchmark evidence

## Goal

Add a reproducible benchmark and documentation surface that explains where Codegraph saves time and where it does not, without marketing claims that cannot be re-run.

## Design

Create a benchmark harness that runs fixed repo-understanding tasks with and without Codegraph assistance and records tool-call counts, file reads, wall time, and answer completeness checks.

Do not publish broad performance claims until the harness is reproducible in CI or documented for local reruns.

## Benchmark structure

Directory:

```text
docs/benchmarks/
  README.md
  scenarios.json
  results.example.json
scripts/benchmarks/
  run-scenario.mjs
  summarize-results.mjs
```

Scenario schema:

```json
{
  "id": "repo-orientation-small-ts",
  "repo": "local-fixture-or-url",
  "task": "Explain how the request reaches the handler",
  "expectedAnchors": ["src/server.ts", "src/routes.ts"],
  "metrics": ["toolCalls", "fileReads", "wallTimeMs"]
}
```

## Documentation

Add a concise docs page:

- what was measured
- how to reproduce
- hardware/runtime assumptions
- why file reads and tool calls matter
- where results are expected to vary
- current limitations

Prefer a modest table over inflated claims.

## Initial scenarios

Use local fixtures first so CI can run them:

- small TypeScript service fixture
- Python import/reference fixture
- SQL migration plus application review fixture
- mixed docs/source graph fixture

External repo benchmarks can be optional and manually run.

## Files likely touched

- new `docs/benchmarks/README.md`
- new `docs/benchmarks/scenarios.json`
- new `scripts/benchmarks/run-scenario.mjs`
- new `scripts/benchmarks/summarize-results.mjs`
- `README.md` docs index link
- `docs/how-it-works.md` or `docs/agent-workflows.md` link
- tests for scenario schema parsing

## Tests

- scenario JSON schema validates.
- summarizer handles multiple runs and reports medians.
- benchmark scripts can run against local fixtures without network.
- README table is generated or checked from results fixture.

## Acceptance

- A maintainer can run one documented command to reproduce local benchmark examples.
- Public docs explain methodology and limitations.
- No benchmark claim is disconnected from a checked-in scenario or result file.

## Review pass

Checked scope: this plan prioritizes reproducibility and modest claims. It creates evidence infrastructure before adding broad public performance messaging.
