# AGENT DIRECTIVES

## General

- Never use `any` or `as unknown as`
- Never use `=== true`, `=== false`, etc. in boolean conditions; keep them as terse and simple as possible like `!condition`. Extract conditions to variables when the variable name adds clarity/insight into the reason for the condition.
- Always consider the impact of a change on tests or when more test cases are needed. Never make tests pass for the sake of passing; always exercise real behavior.
- Always keep documentation updated and accurate while being minimal and concise.
- When language support changes, update `docs/language-parity.md` and `docs/scenario-catalog.md` in the same change so support claims, limitations, and fixture coverage stay aligned.
- When adding or changing a cross-file language scenario, add or update the nearest language test in `tests/languages/*.test.ts` and the shared semantic coverage in `tests/goto.test.ts`, `tests/references.test.ts`, and `tests/native-semantic-parity.test.ts` when the language uses the native runtime.
- Always keep the README.md table of contents updated whenever README sections are added, removed, or renamed.
- Always keep `codegraph-skill/codegraph/SKILL.md` updated when CLI commands, flags, or capabilities change. This file is the skill definition used by agents and must reflect the current tool surface.
- Any persistent storage schema change (e.g. SQLite tables/columns/indexes) MUST include a migration path for existing on-disk data. If using `CREATE TABLE IF NOT EXISTS`, you must also `ALTER TABLE` / backfill as needed (or introduce explicit schema versioning) and add a regression test that starts from an older schema to prove upgrades work.
- DO NOT use curly quote variants or other non-standard characters humans would not type with a standard QWERTY keyboard.
