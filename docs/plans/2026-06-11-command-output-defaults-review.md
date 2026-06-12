# Command Output Defaults Review Plan

This review is now complete for the initial command set. The outcome is intentionally conservative: flip `codegraph duplicates` to pretty-by-default, keep explicit JSON everywhere it already exists, and leave other command defaults unchanged unless the readable form is already the stronger primary surface.

## Goal

- Prefer the most useful default output for humans and agents when those consumers benefit from the same surface.
- Keep explicit machine-readable JSON available everywhere it is needed.
- Make default-format changes intentionally, command by command, rather than as an unreviewed blanket flip.

## Completed Decision: `duplicates`

Why this command went first:

- `duplicates` is primarily used for triage, review, and deciding what to inspect next.
- Pretty output is denser and more scannable than grouped JSON for both humans and agents.
- `--json` remains available for programmatic consumers.

Checklist before flipping the default:

- [x] Confirm there are no documented or tested expectations that `duplicates` defaults to JSON.
- [x] Review whether any scripts, examples, or agent guidance assume plain `duplicates ...` returns JSON.
- [x] Decide whether default pretty output should also imply default `--sort actionability`.
- [x] Decide whether JSON should stay similarity-sorted unless `--sort` is explicit.
- [x] Ensure `--json` remains the stable machine contract and is documented as such.
- [x] Add regression coverage for default-format behavior, `--json`, and `--pretty` overrides.
- [x] Update `docs/cli.md`, `codegraph-skill/codegraph/SKILL.md`, and user-facing examples in the same change.

Decision:

- [x] `duplicates` now defaults to pretty output.
- [x] Default pretty output also defaults to `--sort actionability`.
- [x] JSON remains opt-in with `--json` and stays similarity-sorted unless `--sort` is explicit.
- [x] `--raw-pairs` remains JSON-only and continues to work without requiring `--json` because it suppresses the pretty default.

Compatibility notes:

- Existing plain `duplicates ...` invocations now emit pretty output instead of JSON.
- Programmatic consumers must use `--json` explicitly.
- `--raw-pairs` remains a machine/debugging mode and still yields JSON-oriented output.

## Command-by-Command Review Checklist

For each command, answer these before changing the default output:

- [x] Primary consumer: human, agent, script, or mixed?
- [x] Is the command usually used for triage/inspection or for downstream tooling?
- [x] Does the pretty/readable form preserve the critical information needed for the common next step?
- [x] Does the JSON form carry stable fields, handles, or counts that downstream consumers rely on?
- [x] Would changing the default silently break existing examples, tests, or scripted workflows?
- [x] Is the readable form materially lower-token and higher-signal for agents than the JSON form?
- [x] Are sort order, truncation, omission counts, and hidden-evidence behavior still understandable in the readable form?
- [x] Can the readable form be explicit about heuristics vs exact facts?
- [x] Does the command need both a human default and an explicit machine mode?
- [x] If defaults diverge by command, is the rule simple enough to document clearly?

## Commands Reviewed

High-priority review set:

- [x] `duplicates` — flip to pretty-by-default. Primary use is inspection/triage. JSON remains the stable machine contract via `--json`.
- [x] `orient` — keep JSON default. Primary use is mixed, but stable packet handles, omissions, and follow-up automation matter enough that plain output should stay structured; `--pretty` remains the compact reading surface.
- [x] `inspect` — keep JSON default. Current command only exposes a structured report surface, and no dedicated pretty formatter exists yet.
- [x] `search` — keep readable default. The formatted result is already the inspection-first surface; `--json` is available when exact handles and fields are needed.
- [x] `explain` — keep readable default. The formatted explanation is already the main human/agent surface; `--json` stays opt-in for exact follow-up fields.
- [x] `impact` — keep JSON default. The report often feeds downstream tooling and review automation; `--pretty` remains the human summary mode.
- [x] `review` — keep JSON default. The full review report is the stable machine contract; `--summary` / `--pretty` remain explicit human modes.
- [x] `hotspots` — keep readable default. The plain list is concise, high-signal, and sufficient for the common next step.
- [x] `cycles` — keep readable default. The default textual report is already optimized for inspection and remediation.
- [x] `unresolved` — keep readable default. The plain summary is concise and directly actionable; `--json` remains available for tooling.

Lower-priority or likely-JSON-first review set:

- [ ] `artifact build` — likely keep JSON opt-in / artifact-oriented behavior; not reviewed in depth yet.
- [ ] `graph --json` / graph-exporting flows — likely machine-contract-first; not reviewed in depth yet.
- [ ] `drift` — likely keep explicit mode selection because it already supports `--pretty`, `--json`, and `--compact-json` with different consumers.
- [ ] `sql` — likely machine-contract-first for query output, but not reviewed in depth yet.
- [ ] Any command whose primary value is a stable schema rather than interactive reading.

## Review Dimensions Per Command

Checklist of things inspected and compared:

- [x] Current default output format
- [x] Existing `--pretty`, `--summary`, `--compact-json`, or `--json` support
- [x] Current docs/examples and whether they show the default form
- [x] Test coverage for default output behavior
- [x] Presence of stable handles/IDs needed for follow-up commands
- [x] Omission/truncation signaling quality in readable mode
- [x] Whether ranking/ordering is heuristic or exact
- [x] Whether agents would benefit from denser prose-like summaries
- [x] Whether humans and agents want the same top-level output by default
- [x] Migration cost of flipping the default now vs later

## Policy Decisions

- [x] "Best for humans and agents" should be the default rule unless a machine contract argues otherwise.
- [x] Every agent-facing command should support an explicit readable mode and an explicit JSON mode where practical.
- [x] Agent-oriented inspection commands should prefer readable output by default when that surface preserves the common next step.
- [x] Machine-contract commands should continue to default to JSON when stable fields, handles, or automation are the main value.
- [x] Sorting defaults may change alongside format defaults when the readable form is explicitly triage-oriented.
- [x] Docs should call out which commands are inspection-first vs machine-contract-first when the distinction matters.

## Recommended Output Default Policy

Inspection-first commands:

- Prefer readable output by default.
- Keep `--json` explicit for structured follow-up use.
- Current set after this review: `duplicates`, `search`, `explain`, `hotspots`, `cycles`, `unresolved`.

Machine-contract-first commands:

- Prefer JSON by default.
- Keep readable modes explicit and task-oriented.
- Current set after this review: `orient`, `inspect`, `impact`, `review`.

Why `orient` stays JSON-first:

- The common next step often depends on stable packet handles, omission counts, and exact recommended follow-ups.
- `orient --pretty` is still the best first-read surface when a human or agent wants a compact orientation packet.

## Acceptance Criteria for the Review

- [x] We have a written recommendation for `duplicates` default output.
- [x] We have a command-by-command recommendation for the high-priority review set.
- [x] Each recommendation includes compatibility risk and migration notes.
- [x] Approved default changes ship with docs and tests in the same PR.
- [x] The final policy is simple enough to explain in CLI docs and the skill docs without caveat sprawl.
