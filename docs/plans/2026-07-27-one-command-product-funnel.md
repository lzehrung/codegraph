# One-command product funnel

Status: Implemented

Parent review: [Project improvement review](./2026-07-27-project-improvement-review.md)

Related plans:

- [Self-contained distribution](./2026-07-03-04-self-contained-distribution.md)
- [Agent installer workflow](./2026-07-03-05-agent-installer-workflow.md)
- [Upgrade command](./2026-07-03-13-upgrade-command.md)

## Vision

A new user should move from no Codegraph installation to one useful, evidence-backed repository answer in under five minutes. The path should be obvious without reading the full CLI reference, safe without hidden writes, and consistent across package, standalone, source-checkout, and agent-client installation channels.

The funnel is:

```text
Install one trusted artifact
  -> configure one detected agent client
  -> verify runtime health
  -> ask one real repository question
  -> receive bounded evidence and one copyable follow-up
```

This program is not a marketing-only rewrite. It changes the default CLI entrance, turns the existing installer into a guided transaction, ships self-contained release artifacts, and validates the entire path on clean environments.

## Why this is needed

The product already has the hard capabilities:

- `explore` provides a broad first answer with bounded packets and follow-ups.
- `orient` provides a deterministic first-turn map.
- `install` detects Codex, Claude, Cursor, Gemini, OpenCode, and generic agent skill directories.
- installer writes are owned and reversible.
- `doctor` reports runtime/package/native state.
- MCP exposes the same agent-facing search and navigation contracts.

At plan creation, the entrance was fragmented:

- bare `codegraph` fell through to the graph command rather than teaching the product path,
- the full help was command-oriented rather than task-oriented,
- unknown commands failed without a useful correction,
- `codegraph install` required users to infer `--detect`, `--dry-run`, and `--yes`,
- GitHub Packages installation required scoped registry configuration,
- npm release tarballs did not include Node or the native addon,
- no clean-machine test proved install-to-first-query duration and output.

The result was a capable tool with a high activation cost.

## Product principles

1. **Task first.** Lead with questions users have, not an alphabetical command inventory.
2. **No silent writes.** Interactive confirmation or explicit `--yes` is always required.
3. **One recommendation.** Every state offers one primary next action, then alternatives.
4. **Copyable commands.** Paths are quoted correctly for the active shell where possible.
5. **Structured output stays stable.** Human guidance never leaks into JSON or protocol responses.
6. **No hidden network behavior.** Installed commands do not download or phone home unless the user invokes an explicit installer/update path.
7. **Native state is visible.** Reduced mode is useful but never presented as equivalent semantic coverage.
8. **Fast entrance.** No-argument help and typo handling stay on the lightweight CLI path.

## Primary personas

### Agent user

Has Codex, Claude, Cursor, Gemini, or OpenCode and wants Codegraph available as MCP tools and a bundled skill.

Success: one configuration command, client restart if required, then an agent can call `explore` or `search`.

### Terminal user

Wants to inspect a repository without configuring an agent.

Success: install, `doctor`, then `codegraph explore "..." --root .`.

### Contributor

Uses a source checkout and needs commands that distinguish contributor workflow from published/global guidance.

Success: `npm install`, `npm run build`, then `node ./dist/cli.js ...` with the same onboarding content.

## Target journey

### Published package path

```bash
npm config set "@lzehrung:registry" "https://npm.pkg.github.com"
npm install -g @lzehrung/codegraph
codegraph install
```

`codegraph install` detects local clients, shows exact proposed changes, asks once on an interactive terminal, applies only after confirmation, runs a bounded doctor check, and prints the client-specific first query.

### Standalone path

PowerShell:

```powershell
irm https://github.com/lzehrung/codegraph/releases/latest/download/install.ps1 | iex
```

POSIX shell:

```bash
curl -fsSL https://github.com/lzehrung/codegraph/releases/latest/download/install.sh | sh
```

The bootstrap script downloads a platform archive and `SHA256SUMS`, verifies the selected archive before extraction, installs under a user-owned directory, and reports the launcher directory for `PATH`. The preview channel is checksummed but not signed; documentation must also show an inspect-then-run alternative for users who do not pipe remote scripts to a shell.

After installation, the script invokes or recommends the same `codegraph install` flow. The standalone archive includes Node, the CLI, production dependencies, bundled skill, and matching native addon; it does not depend on npm registry configuration at runtime.

### Source checkout path

```bash
npm install
npm run build
node ./dist/cli.js install
```

Contributor docs keep using `node ./dist/cli.js`. Bare `codegraph` remains reserved for published/global guidance.

## Default CLI entrance

### Bare invocation

Change `codegraph` with no arguments to print concise task-oriented help and exit 0. It must not build an index, scan the project, read config, or load command modules.

Proposed output contract:

```text
codegraph - Ask structural questions about a repository

Start here:
  Understand a repository   codegraph explore "how does auth reach the database?" --root .
  Review local changes      codegraph review --base HEAD --head WORKTREE --summary
  Find a symbol or file     codegraph search "SessionManager" --json
  Configure an agent        codegraph install
  Check runtime health      codegraph doctor

Run codegraph --help for all commands.
```

Keep this output under 15 lines and 1 KiB. Measure startup against `codegraph --version`; p50 may regress by no more than 10%.

`codegraph --help` retains the complete reference but moves the same five-task block above command details.

### Unknown command

For an unknown command:

1. return the current usage-error exit code,
2. print `Unknown command "...".`,
3. print up to three close command names,
4. print one task-oriented route when the token resembles a user intent,
5. never start project discovery.

Example:

```text
Unknown command "serach".
Did you mean: search?
Try: codegraph search "<query>" --json
```

Use a dependency-free edit-distance helper in the lightweight CLI graph. Normalize ASCII case, compare exact command names and intentional aliases, cap suggestions by both distance and count, and sort deterministically by distance then command name.

Do not guess and execute. Suggestions are text only.

### Single command catalog

Add `src/cli/commandCatalog.ts` as lightweight metadata:

```ts
type CliCommandMetadata = {
  name: string;
  summary: string;
  family: "start" | "search" | "navigate" | "review" | "graph" | "manage";
  aliases?: readonly string[];
};
```

Derive known-command checks and help command lists from the catalog. Dispatch remains explicit so importing the catalog does not eagerly import handlers.

Add a test that every dispatchable command is present exactly once and every catalog command reaches a handler or documented alias. This removes help/dispatch drift without a broad command-framework rewrite.

## Guided installer transaction

The current registry implementation already detects targets, previews actions, writes exact owned blocks/files, and requires `--yes`. Preserve those safety properties while improving the interactive path.

### State machine

```text
DETECT
  -> no targets: explain and offer explicit --target choices
  -> targets found: PREVIEW
PREVIEW
  -> non-interactive without --yes: print copyable --dry-run/--yes commands, exit usage error
  -> interactive: show target + path + create/update/unchanged actions, PROMPT
PROMPT
  -> no/EOF: exit 0 with no changes
  -> yes: APPLY
APPLY
  -> verify owned files/config
  -> run bounded health checks
  -> print client-specific restart and first-query instructions
```

### Interactive behavior

When stdin and stderr are TTYs and neither `--yes` nor `--dry-run` is supplied:

1. detect targets,
2. compute the same dry-run result used by `--dry-run`,
3. show a concise table grouped by target,
4. ask `Configure Codegraph for N detected target(s)? [y/N]`,
5. accept only `y` or `yes` case-insensitively,
6. treat blank, EOF, interrupt, and all other input as no,
7. recompute and apply using existing atomic writes,
8. verify exact owned markers/payloads.

Use `node:readline/promises`; add no prompt dependency.

Explicit `--yes` remains the noninteractive automation path. Explicit target lists preserve their current meaning. `--dry-run`, `--detect`, and `--print-config` remain noninteractive.

### No detected targets

Do not return an empty successful install that appears to have configured something. Print:

- supported clients,
- what paths were checked,
- `codegraph install --target <name> --dry-run`,
- `codegraph install --target <name> --yes`.

Structured output includes `detected: []`, `installed: false`, and a stable `reason: "no-targets-detected"` without prose-only ambiguity.

### Verification

After writes, verify only owned state:

- expected MCP entry or TOML marker block exists once,
- bundled skill payload hash matches the installed payload,
- pointer/marker files resolve inside the target directory,
- no unrelated config keys changed,
- `codegraph doctor` can resolve package and native status.

Do not launch or modify the agent application. Print restart/reload guidance by target.

### Agent-specific completion messages

Keep completion output short and exact:

- Codex/Claude/Cursor/Gemini/OpenCode: restart or reload the MCP client, then ask it to use Codegraph to map the repository.
- generic `agents`: state that only the skill was installed and provide the manual MCP command/config path if applicable.
- terminal-only users: provide one `explore` command.

Never claim the agent has connected until an MCP handshake was observed.

## First-query experience

### Recommended first command

Use `explore`, not `orient`, as the primary human onboarding command because it answers a concrete question. Keep `orient` as the fallback when the user does not yet know what to ask.

Primary:

```bash
codegraph explore "Where should I start in this repository?" --root .
```

Alternative:

```bash
codegraph orient --root . --budget small
```

The first successful human-readable response should end with one clearly labeled recommended next command. Existing response schemas and follow-up bounds remain unchanged.

### Progress and latency

Cold first queries may index. Preserve automatic interactive progress and `--no-progress`. The onboarding docs must explain that the first query prepares the index and later queries reuse it.

Coordinate with the persistent-query-substrate plan, but do not block the basic funnel on that performance work. The funnel smoke records cold and warm durations so the performance program can improve them without changing onboarding contracts.

### Error recovery

For common failures, print one source fix and one diagnostic:

- no files discovered: show the effective root and relevant include/ignore guidance,
- native unavailable: state reduced mode and `codegraph doctor`,
- registry package mismatch: show installed and running versions,
- permission denied during install: show the exact user-owned path and avoid recommending administrator mode by default,
- agent target not detected: show explicit `--target` examples,
- stale MCP process: explain client restart and actual running version.

Human guidance belongs on stderr for failures. JSON remains valid and prose-free.

## Self-contained distribution

This program absorbs the user journey from the existing self-contained-distribution plan. Reuse that plan's artifact layout unless implementation evidence requires a change.

### Artifacts

```text
codegraph-linux-x64.tar.gz
codegraph-linux-arm64.tar.gz
codegraph-darwin-x64.tar.gz
codegraph-darwin-arm64.tar.gz
codegraph-win32-x64.zip
codegraph-win32-arm64.zip
SHA256SUMS
SHA256SUMS.sig or provenance attestation
install.sh
install.ps1
```

Each archive contains:

```text
codegraph-<target>/
  node or node.exe
  bin/codegraph or bin/codegraph.cmd
  dist/
  package.json
  node_modules/production dependencies
  node_modules/@lzehrung/codegraph-native/
  node_modules/@lzehrung/<matching native target>/
  codegraph-skill/
  LICENSE
  THIRD_PARTY_NOTICES
  manifest.json
```

The launcher resolves all paths relative to itself and uses the bundled Node runtime. It must not depend on the current directory, global npm, shell initialization, or registry access.

### Installer bootstrap safety

The release bootstrap scripts:

1. detect supported OS and architecture,
2. resolve an explicit release version, defaulting to latest only when requested,
3. download archive and checksum/provenance files over HTTPS,
4. verify SHA-256 before extraction,
5. reject archive traversal, absolute paths, device files, and unsafe symlinks,
6. extract into a versioned temporary directory,
7. run bundled `codegraph version` and `doctor`,
8. atomically move into a versioned user-owned install root,
9. update a small `current` pointer or launcher atomically,
10. preserve the previous version for rollback,
11. offer agent configuration through the bundled CLI.

Default install roots:

- Windows: `%LOCALAPPDATA%\Programs\codegraph\<version>`
- macOS/Linux: `${XDG_DATA_HOME:-~/.local/share}/codegraph/<version>`
- launchers: user-local bin directory, with explicit PATH instructions when absent

Never overwrite a running native addon in place. Versioned roots and the existing immutable native cache make upgrades safe for long-lived MCP processes.

### Signing and provenance

Checksums alone prove integrity only after the checksum file is trusted. Use GitHub artifact attestations or a documented signing mechanism for release assets. The installer records release URL, version, archive hash, and verification method in an install manifest.

If signing is not ready in the first PR, label the channel preview and require checksum verification; do not describe it as signed.

### Unsupported platforms

Detect unsupported OS/architecture before download and link to package/source installation. Do not silently install reduced mode while claiming the standalone target is native-capable.

Runtime certification comes from the release-semantic-certification program. A standalone artifact cannot be promoted from preview until its matching host smoke passes.

## Upgrade behavior

Do not add an `upgrade` command that only checks for updates and prints instructions. That behavior was rejected as misleading.

A real standalone/package upgrade must:

- detect the active installation channel,
- show current and target versions,
- confirm unless `--yes`,
- execute the channel-specific update,
- stream subprocess output,
- propagate exit status,
- verify the resulting installed version,
- handle permissions without defaulting to elevation,
- refuse dirty or detached source-tree updates,
- avoid Windows native-addon locking through versioned immutable installs.

The funnel may initially print channel-specific manual update commands. Name them "update instructions", not `upgrade`, until the full contract above exists.

## Landing-page and documentation hierarchy

Keep `README.md` as the landing page and index, not the canonical reference for every workflow.

### README top section

Within the first screen:

1. one sentence: what Codegraph does,
2. one verified install path,
3. one `codegraph install` command,
4. one first repository question,
5. one small real output excerpt or screenshot generated from a checked fixture,
6. links to installation, agent workflows, benchmarks, and CLI reference.

Do not lead with every command, package role, or architecture detail.

### Canonical docs

- `docs/installation.md`: all channels, verification, PATH, updates, uninstall
- `docs/agent-workflows.md`: agent setup and first prompts
- `docs/cli.md`: no-arg, suggestions, installer flags, exit codes
- `docs/mcp.md`: client configuration and handshake troubleshooting
- `docs/how-it-works.md`: indexing/caching behavior after first query
- `PUBLISHING.md`: standalone archive assembly and provenance
- `codegraph-skill/codegraph/SKILL.md`: exact CLI commands and agent guidance

Update README table of contents whenever headings change.

## Funnel smoke harness

Add `scripts/onboarding/`:

- `funnel-contract-lib.mjs`: result schema and step assertions
- `run-funnel-smoke.mjs`: clean-home scenario runner
- `standalone-install-lib.mjs`: shared archive/install validation where safe
- tests for output parsing, timeout, cleanup, and secret redaction

Run one channel at a time:

```bash
node scripts/onboarding/run-funnel-smoke.mjs --channel source --root . --output funnel-source.json
node scripts/onboarding/run-funnel-smoke.mjs --channel package --artifact <root-package.tgz> --output funnel-package.json
node scripts/onboarding/run-funnel-smoke.mjs --channel standalone --artifact <codegraph-target-archive> --target <target> --output funnel-standalone.json
```

Result schema:

```ts
type FunnelSmokeResultV1 = {
  schemaVersion: 1;
  scenario: "clean-home-source" | "exact-package-candidate" | "extracted-standalone";
  channel: "source" | "package" | "standalone";
  target: "win32-x64" | "win32-arm64" | "darwin-x64" | "darwin-arm64" | "linux-x64" | "linux-arm64";
  status: "pass" | "fail";
  version: string | null;
  timings: {
    totalMs: number;
    steps: Array<{ name: string; durationMs: number }>;
  };
  checks: Array<{
    name: string;
    status: "pass" | "fail" | "skipped";
    durationMs: number;
    exitCode?: number | null;
  }>;
  diagnostics: Array<{
    code: string;
    message: string;
    step?: string;
    command?: string;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
  }>;
};
```

The runner uses temporary `HOME`, `USERPROFILE`, XDG, application-data, and npm-cache roots plus a temporary repository fixture. It must fail if the installed binary resolves modules from the developer checkout.

### Scenarios

1. Package install from exact candidate tarballs.
2. Standalone archive install through the bootstrap logic without piping from the network.
3. Source checkout contributor flow.
4. No detected agent target.
5. One detected target with decline.
6. One detected target with confirmation.
7. Noninteractive install without `--yes`.
8. Explicit `--yes` install.
9. Native available and native unavailable doctor states.
10. First `explore` query and one follow-up command.
11. MCP initialize/list-tools/search after configuration.
12. Uninstall removes owned state and preserves unrelated config.

Use fake home directories containing realistic minimal client config, not actual developer settings.

## Acceptance metrics

### Correctness

- bare invocation exits 0, prints task help, and does no discovery,
- typo suggestions are deterministic and never execute,
- interactive decline writes nothing,
- EOF/interrupt writes nothing,
- confirmed installer changes only owned state,
- packed and standalone binaries pass `version`, `doctor`, first query, and MCP handshake,
- uninstall preserves unrelated config byte-for-byte where formatting permits.

### Time

On clean supported CI runners, excluding artifact download bandwidth but including extraction/configuration/indexing:

- package or standalone install to successful `doctor`: <= 2 minutes,
- install to first successful bounded query: <= 5 minutes,
- no-arg help p50: within 10% of `--version`,
- installer detection and preview: <= 2 seconds on synthetic homes,
- warm repeat query recorded separately from cold first query.

Use timeouts to catch hangs, not as the only performance evidence.

### Usability

A fresh-user test script provides only:

- the install command,
- a sample repository path,
- the goal "find where authentication reaches storage".

Success requires reaching a source-backed answer without opening the full CLI reference. Record wrong turns and revise guidance; do not add telemetry to user machines.

## Implementation sequence

### PR 1: lightweight entrance

- add command catalog,
- make bare invocation task-oriented,
- add typo suggestions,
- move task routes to the top of full help,
- add startup and dispatch parity tests.

Exit: no-arg and unknown-command paths load no heavy project modules.

### PR 2: guided installer

- add TTY detection, preview, prompt, apply, verify state machine,
- handle no-target state explicitly,
- add client-specific completion guidance,
- preserve `--yes`, `--dry-run`, `--detect`, and `--print-config`.

Exit: clean-home interactive and automation scenarios pass on Windows, macOS, and Linux.

### PR 3: first-query and docs funnel

- update README landing section and canonical docs,
- add clear cold-index progress and one recommended follow-up,
- add package/source funnel smoke harness.

Exit: package candidate reaches first query and MCP handshake in the clean-home harness.

### PR 4: standalone archives

- assemble Node, CLI, production deps, native package, skill, notices, and manifest,
- add relative launchers,
- attach preview artifacts to releases,
- validate every host-executable target.

Exit: archives run on clean hosts without npm or system Node.

### PR 5: verified bootstrap and promotion

- add install scripts, checksum/provenance validation, atomic versioned install, rollback metadata,
- run standalone funnel matrix,
- promote channel from preview after release certification passes.

Exit: documented one-command path installs verified bytes and reaches first answer.

### PR 6: real upgrade, only if separately approved

- implement channel-aware update execution to the full contract,
- add dirty/detached source and Windows locking tests,
- never ship a check-only command named `upgrade`.

Exit: resulting version is verified after a real update and failures propagate.

## Required tests

### CLI entrance

- no args, `--help`, `help`, version flags
- known command catalog/dispatch completeness
- close typo, distant typo, multiple deterministic suggestions
- no config/discovery imports on lightweight paths
- stdout/stderr and exit-code contracts
- JSON modes remain prose-free

### Installer

- TTY yes/no/blank/EOF/interrupt
- non-TTY with and without `--yes`
- no targets and explicit targets
- config create/update/unchanged/idempotent
- invalid config and permission errors
- unrelated config preservation
- verification failure after write with actionable recovery
- concurrent installer attempts and atomic output
- Windows and POSIX path quoting

### Standalone

- archive manifest and checksum
- traversal, absolute path, symlink, and checksum rejection
- launcher from directories containing spaces
- no system Node/npm available
- native package selected for target
- reduced-mode behavior only where intentional
- versioned atomic replacement and rollback
- long-lived Windows MCP process during update
- uninstall owns only its install root and launcher

### Funnel

- exact candidate package install
- first query has source evidence and bounded follow-up
- MCP handshake from installed binary
- no checkout module leakage
- clean HOME and cleanup after failure
- duration fields and failure artifacts

Run targeted suites during implementation, then `npm run check`. Drive the actual CLI and packed binaries; source-text assertions alone do not prove the funnel.

## Documentation compatibility

This work changes public CLI and installation behavior. The implementation PRs must update, as applicable:

- `README.md`
- `docs/installation.md`
- `docs/cli.md`
- `docs/agent-workflows.md`
- `docs/how-it-works.md`
- `docs/mcp.md`
- `PUBLISHING.md`
- `codegraph-skill/codegraph/SKILL.md`

When standalone distribution lands, update package role and target guidance. When no-arg or installer output changes, update help snapshots and command examples in the bundled skill in the same PR.

## Risks and mitigations

### Remote bootstrap trust

Piping scripts to a shell is high trust. Publish inspect-first alternatives, verify signed/checksummed artifacts, keep scripts short, and test every destructive path.

### Installer modifies user configuration

Preview exact owned changes, default prompts to no, preserve `--dry-run`, use atomic writes, and verify unrelated config remains.

### Help path regresses startup

Keep catalog metadata dependency-free and enforce eager-module denylist/startup tests.

### Standalone artifact size

Bundled Node and dependencies are larger than npm installation. Publish sizes, keep npm as a supported channel, and avoid bundling development files.

### Multiple installation channels confuse upgrades

Write channel and version into the install manifest. Doctor reports running, installed, native, and channel identities.

### Reduced mode appears successful

Doctor and first-query diagnostics state the backend. Standalone supported targets require native runtime certification.

### Scope grows into a command framework rewrite

Do not replace explicit dispatch. Add only the lightweight catalog needed for help and suggestions.

## Definition of done

- [x] Bare `codegraph` prints concise task-oriented help and exits 0.
- [x] Unknown commands offer bounded deterministic suggestions without discovery.
- [x] Command metadata and dispatch cannot drift silently.
- [x] Interactive `codegraph install` previews, confirms, applies, and verifies owned changes.
- [x] Noninteractive writes still require `--yes`.
- [x] No-target and reduced-native states are explicit.
- [x] README leads with install, configure, and first query.
- [x] Package/source funnel smoke reaches a bounded answer and MCP handshake.
- [x] Standalone archives include Node, native runtime, CLI, skill, notices, and manifest.
- [x] Bootstrap scripts verify artifact integrity and install atomically under a user-owned versioned root.
- [x] Clean-host package and standalone journeys complete within acceptance budgets.
- [x] Uninstall preserves unrelated user state.
- [x] No misleading check-only `upgrade` command ships.
- [x] Canonical docs and bundled skill match the CLI.
- [x] `npm run check` passes.
