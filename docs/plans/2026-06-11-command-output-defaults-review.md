# Command Output Defaults Review Plan

This plan captures follow-up work for command output defaults, with an explicit near-term goal to make `codegraph duplicates` default to pretty output if the agent and human use cases stay aligned.

## Goal

- Prefer the most useful default output for humans and agents when those consumers benefit from the same surface.
- Keep explicit machine-readable JSON available everywhere it is needed.
- Make default-format changes intentionally, command by command, rather than as an unreviewed blanket flip.

## Near-Term Decision Candidate: `duplicates`

Why this command is first:

- `duplicates` is primarily used for triage, review, and deciding what to inspect next.
- The new pretty output is denser and more scannable than raw grouped JSON for both humans and agents.
- `--json` already remains available for programmatic consumers.

Checklist before flipping the default:

- [ ] Confirm there are no documented or tested expectations that `duplicates` defaults to JSON.
- [ ] Review whether any scripts, examples, or agent guidance assume plain `duplicates ...` returns JSON.
- [ ] Decide whether default pretty output should also imply default `--sort actionability`.
- [ ] Decide whether JSON should stay similarity-sorted unless `--sort` is explicit.
- [ ] Ensure `--json` remains the stable machine contract and is documented as such.
- [ ] Add regression coverage for default-format behavior, `--json`, and `--pretty` overrides.
- [ ] Update `docs/cli.md`, `codegraph-skill/codegraph/SKILL.md`, and any user-facing examples in the same change.

## Command-by-Command Review Checklist

For each command, answer these before changing the default output:

- [ ] Primary consumer: human, agent, script, or mixed?
- [ ] Is the command usually used for triage/inspection or for downstream tooling?
- [ ] Does the pretty/readable form preserve the critical information needed for the common next step?
- [ ] Does the JSON form carry stable fields, handles, or counts that downstream consumers rely on?
- [ ] Would changing the default silently break existing examples, tests, or scripted workflows?
- [ ] Is the readable form materially lower-token and higher-signal for agents than the JSON form?
- [ ] Are sort order, truncation, omission counts, and hidden-evidence behavior still understandable in the readable form?
- [ ] Can the readable form be explicit about heuristics vs exact facts?
- [ ] Does the command need both a human default and an explicit machine mode?
- [ ] If defaults diverge by command, is the rule simple enough to document clearly?

## Commands to Review

High-priority review set:

- [ ] `duplicates`
- [ ] `orient`
- [ ] `inspect`
- [ ] `search`
- [ ] `explain`
- [ ] `impact`
- [ ] `review`
- [ ] `hotspots`
- [ ] `cycles`
- [ ] `unresolved`

Lower-priority or likely-JSON-first review set:

- [ ] `artifact build`
- [ ] `graph --json` / graph-exporting flows
- [ ] `drift`
- [ ] `sql`
- [ ] Any command whose primary value is a stable schema rather than interactive reading

## Review Dimensions Per Command

Checklist of things to inspect and compare:

- [ ] Current default output format
- [ ] Existing `--pretty`, `--summary`, `--compact-json`, or `--json` support
- [ ] Current docs/examples and whether they show the default form
- [ ] Test coverage for default output behavior
- [ ] Presence of stable handles/IDs needed for follow-up commands
- [ ] Omission/truncation signaling quality in readable mode
- [ ] Whether ranking/ordering is heuristic or exact
- [ ] Whether agents would benefit from denser prose-like summaries
- [ ] Whether humans and agents want the same top-level output by default
- [ ] Migration cost of flipping the default now vs later

## Policy Questions to Decide Explicitly

- [ ] Should "best for humans and agents" be the default rule unless a machine contract argues otherwise?
- [ ] Should every command support an explicit readable mode and an explicit JSON mode?
- [ ] Should agent-oriented commands prefer readable output by default even when JSON exists?
- [ ] Should machine-contract commands continue to default to JSON even if readable output is added?
- [ ] Should sorting defaults change alongside format defaults, or remain independent?
- [ ] Should docs call out which commands are "inspection-first" vs "machine-contract-first"?

## Acceptance Criteria for the Review

- [ ] We have a written recommendation for `duplicates` default output.
- [ ] We have a command-by-command recommendation for the high-priority review set.
- [ ] Each recommendation includes compatibility risk and migration notes.
- [ ] Any approved default change ships with docs and tests in the same PR.
- [ ] The final policy is simple enough to explain in CLI docs and the skill docs without caveat sprawl.
