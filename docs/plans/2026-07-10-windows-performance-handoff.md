# Windows performance investigation handoff

## Goal

Reproduce the public documentation benchmark on the native Windows host, separate process startup from Codegraph work, and collect Node CPU profiles before changing performance-sensitive code.

The immediate question is whether the several-second checked results are specific to Node module loading from the WSL2 Windows-mounted filesystem or also occur in native Windows execution.

## Repository state

- Pull request: <https://github.com/lzehrung/codegraph/pull/150>
- Branch: `p15/public-docs-benchmarks`
- Latest handoff commit before this document: `0b83778`
- Benchmark guide: [`docs/benchmarks/README.md`](../benchmarks/README.md)
- Scenarios: [`docs/benchmarks/scenarios.json`](../benchmarks/scenarios.json)
- Checked results: [`docs/benchmarks/results.example.json`](../benchmarks/results.example.json)
- Benchmark runner: [`scripts/benchmarks/run-scenario.mjs`](../../scripts/benchmarks/run-scenario.mjs)

PR #150 adds the reproducible benchmark harness, checked result validation, clearer benchmark interpretation, and an initial Node startup diagnosis. Do not regenerate or replace `results.example.json` until the Windows measurements have been reviewed.

## What has already been established

The checked artifact was generated under WSL2 from `/mnt/e/git repos/codegraph`. It measures a fresh Node subprocess, cold in-process index, and `--cache off` for every Codegraph sample.

The baseline is not process-symmetric:

- Baseline reads run inside the already-started benchmark harness.
- Each Codegraph sample starts `node ./dist/cli.js explore ...` as a new subprocess.
- The baseline receives three files selected in advance.
- Codegraph performs startup, discovery, indexing, search, graph traversal, packet construction, and JSON serialization.

### Measurements from the WSL host

Same machine and native addon, with the runtime copied from `/mnt/e` to native WSL `/tmp` for comparison:

| Probe                                     | WSL `/mnt/e` | WSL native `/tmp` |
| ----------------------------------------- | -----------: | ----------------: |
| `node ./dist/cli.js --version`            |     3,423 ms |            135 ms |
| One-shot TypeScript `explore --cache off` |     3,808 ms |            248 ms |
| Import agent modules in-process           |     2,797 ms |             92 ms |
| Standalone `explore` after import         |       672 ms |            114 ms |
| First `explore` on a persistent session   |       408 ms |             34 ms |
| Repeated `explore` on the same session    |        23 ms |             11 ms |

Fresh `explore` medians across all four scenarios were 3.81-4.41 seconds on `/mnt/e`. The measured CLI startup floor was 3.42 seconds, or roughly 78-90% of those one-shot measurements.

Node's built-in profiler attributed most of the 3.22-second `--version` profile to module-resolution filesystem activity. Trace events recorded 537 synchronous `lstat` calls, 437 `open`/`read`/`close` groups, and 345 `fstat` calls; traced synchronous filesystem spans totaled 1.38 seconds.

Disk caching did not materially improve the three-file fixture because startup dominated:

- `--cache off`: approximately 4.11 seconds median.
- `--cache disk`: approximately 4.18 seconds median.

### Current diagnosis

The several-second checked values are primarily a cold Node ESM startup problem amplified by WSL DrvFS metadata latency. They are not evidence that parsing or graph queries intrinsically require several seconds.

`src/cli.ts` eagerly imports most command handlers before dispatch. Even `--version` loads a large module graph, so hundreds of filesystem metadata operations occur before command-specific work begins.

Persistent sessions already amortize the dominant costs. The likely future optimization order is lazy command loading, reducing or bundling file-level ESM fan-out, preserving persistent MCP/server sessions, and adding process-symmetric benchmark views. Do not implement these until the native Windows profile confirms the cost model.

## Native Windows setup

Use PowerShell from a native Windows checkout, not from WSL and not through a `\\wsl$` path.

```powershell
git fetch origin
git switch p15/public-docs-benchmarks
git pull --ff-only
npm ci
npm run build
node .\dist\cli.js doctor
```

Requirements:

- Use Node 24.15.0 if available so the result is directly comparable.
- `doctor` must report `native.available: true`. Stop and resolve the native binding if it does not.
- Keep the repository, `node_modules`, `dist`, fixtures, and profile output on the same local NTFS volume.
- Close editors or antivirus scans that are actively traversing the checkout where practical, but do not disable normal host security controls merely to improve a result.

Record basic environment information:

```powershell
node -p "JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch }, null, 2)"
Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, TotalVisibleMemorySize
Get-Volume | Select-Object DriveLetter, FileSystem, DriveType, HealthStatus
```

## Measurement protocol

Use at least five samples for diagnostic timings. Discard no sample unless the command failed; report the full sample list and median.

Run commands from the repository root. Redirect command output during timing so console rendering does not dominate.

### 1. CLI startup floor

```powershell
$versionTimes = 1..5 | ForEach-Object {
  (Measure-Command { node .\dist\cli.js --version *> $null }).TotalMilliseconds
}
$versionTimes
($versionTimes | Sort-Object)[2]
```

This command loads the CLI but performs no repository analysis. Treat its median as the cold startup floor for the current CLI architecture.

### 2. Exact TypeScript scenario

```powershell
$query = "Trace serveRequest from src/server.ts through dispatchRequest in src/routes.ts to getHealth in src/handlers/health.ts."
$exploreTimes = 1..5 | ForEach-Object {
  (Measure-Command {
    node .\dist\cli.js explore $query `
      --root tests\samples\benchmarks\typescript-service `
      --cache off --json *> $null
  }).TotalMilliseconds
}
$exploreTimes
($exploreTimes | Sort-Object)[2]
```

Subtracting the startup median from this median is only a rough diagnostic because the phases can interact. Keep total wall time authoritative.

### 3. All public scenarios

Run five samples per variant into a new untracked result file:

```powershell
node .\scripts\benchmarks\run-scenario.mjs `
  --scenario-file docs\benchmarks\scenarios.json `
  --runs 5 `
  --output .tmp\windows-public-docs-benchmark-results.json `
  --require-complete

node .\scripts\benchmarks\summarize-results.mjs `
  --input .tmp\windows-public-docs-benchmark-results.json
```

Do not pass `--write` to the summarizer. Preserve the checked README table until the Windows result has been interpreted and intentionally selected as the new checked artifact.

### 4. Cache comparison

Use the exact TypeScript query above. Run each mode five times in a fresh process:

```powershell
$offTimes = 1..5 | ForEach-Object {
  (Measure-Command {
    node .\dist\cli.js explore $query `
      --root tests\samples\benchmarks\typescript-service `
      --cache off --json *> $null
  }).TotalMilliseconds
}

$diskTimes = 1..5 | ForEach-Object {
  (Measure-Command {
    node .\dist\cli.js explore $query `
      --root tests\samples\benchmarks\typescript-service `
      --cache disk --json *> $null
  }).TotalMilliseconds
}

$offTimes
$diskTimes
```

Report all values. Do not infer cache effectiveness from this tiny fixture alone.

## Node performance introspection

Create a local profile directory:

```powershell
New-Item -ItemType Directory -Force .tmp\profiles | Out-Null
```

### CPU profile: startup only

```powershell
node --cpu-prof `
  --cpu-prof-dir=.tmp\profiles `
  --cpu-prof-name=windows-version.cpuprofile `
  .\dist\cli.js --version
```

### CPU profile: exact `explore`

```powershell
node --cpu-prof `
  --cpu-prof-dir=.tmp\profiles `
  --cpu-prof-name=windows-explore.cpuprofile `
  .\dist\cli.js explore $query `
  --root tests\samples\benchmarks\typescript-service `
  --cache off --json *> $null
```

Load `.cpuprofile` files in the Chrome DevTools Performance panel or the Visual Studio Code JavaScript profiler. Inspect self time and aggregate time for module resolution, filesystem functions, native binding load, file discovery, parsing/query execution, search, and JSON serialization.

### Trace synchronous filesystem activity

```powershell
node --trace-event-categories node,node.fs.sync `
  --trace-event-file-pattern=.tmp\profiles\windows-version-trace.json `
  .\dist\cli.js --version
```

Open the trace in `chrome://tracing` or another Chrome trace viewer. Count synchronous `lstat`, `open`, `read`, `close`, and `fstat` spans and compare their total duration with the WSL profile.

Do not commit raw `.cpuprofile` or trace JSON files. They are machine-specific, can be large, and belong under `.tmp` or as PR attachments.

## Persistent-session probe

Create `.tmp\measure-explore-costs.mjs` with this content:

```js
import { performance } from "node:perf_hooks";
import path from "node:path";

const root = path.resolve("tests/samples/benchmarks/typescript-service");
const query =
  "Trace serveRequest from src/server.ts through dispatchRequest in src/routes.ts to getHealth in src/handlers/health.ts.";

const importStarted = performance.now();
const [{ exploreCodegraph, exploreCodegraphWithSession }, { createAgentSession }] = await Promise.all([
  import("../dist/agent/explore.js"),
  import("../dist/agent/session.js"),
]);
const importMs = performance.now() - importStarted;

const request = { root, query, buildOptions: { cache: "off" } };
const standaloneStarted = performance.now();
await exploreCodegraph(request);
const standaloneMs = performance.now() - standaloneStarted;

const session = createAgentSession({ root, buildOptions: { cache: "off" } });
const firstStarted = performance.now();
await exploreCodegraphWithSession(session, request);
const persistentFirstMs = performance.now() - firstStarted;

const secondStarted = performance.now();
await exploreCodegraphWithSession(session, request);
const persistentSecondMs = performance.now() - secondStarted;

console.log({ importMs, standaloneMs, persistentFirstMs, persistentSecondMs });
```

Run it five times:

```powershell
1..5 | ForEach-Object { node .tmp\measure-explore-costs.mjs }
```

This probe separates module import, a standalone cold session, first use of a reusable session, and repeat use of that same session. It is diagnostic rather than part of the checked public benchmark contract.

## Interpretation gates

Use these as decision points, not pass/fail release thresholds:

- If native Windows `--version` is below roughly 250 ms and cold `explore` is below roughly 500 ms, the WSL-mounted filesystem explains most of the checked multi-second result.
- If `--version` remains above roughly 1 second, profile and reduce cross-platform CLI module loading before optimizing the graph engine.
- If startup is low but cold `explore` remains high, inspect discovery, index construction, text search, packet construction, and serialization in that order.
- If repeated persistent-session `explore` remains above roughly 50 ms on the three-file fixture, investigate session reuse and repeated work.
- Compare proportions and phase shapes, not only absolute Windows-versus-WSL numbers.

The thresholds are diagnostic heuristics derived from the existing WSL `/tmp` measurements. They are not product performance budgets.

## Expected handback

Return or attach:

1. Native Windows environment information.
2. Five startup samples and median.
3. Five exact TypeScript `explore` samples and median.
4. `.tmp\windows-public-docs-benchmark-results.json` or its summarized table.
5. Cache-off and cache-disk sample lists.
6. Five persistent-session probe outputs.
7. `windows-version.cpuprofile` and `windows-explore.cpuprofile`.
8. The synchronous filesystem trace or its event counts and total durations.
9. Any warnings from `doctor`, benchmark commands, or the native backend.

State whether the evidence confirms or rejects the current diagnosis. Keep observed timings separate from inferred causes.

## Verification state before handoff

Completed on the WSL host:

- `npm run bench:docs:check` passed.
- `tests/public-docs-benchmarks.test.ts`: 23 passed.
- `tests/workspace-detection.test.ts`: 4 passed after removing generated fixture caches.
- ESLint, Prettier, TypeScript build, and native release build passed.
- Clean `npm run test:fast`: 178 files passed, 2,177 tests passed, 1 skipped.

The first full test run encountered a generated `.codegraph-cache` temporary-file copy race in `tests/workspace-detection.test.ts`. Removing generated fixture caches and rerunning the test and complete fast suite passed; no source change was required.
