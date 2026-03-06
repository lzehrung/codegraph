# AGENT DIRECTIVES

## General

- Never use `any` or `as unknown as`
- Never use `=== true`, `=== false`, etc. in boolean conditions; keep them as terse and simple as possible like `!condition`. Extract conditions to variables when the variable name adds clarity/insight into the reason for the condition.
- Always consider the impact of a change on tests or when more test cases are needed. Never make tests pass for the sake of passing; always exercise real behavior.
- Always keep documentation updated and accurate while being minimal and concise.
- Always keep the README.md table of contents updated whenever README sections are added, removed, or renamed.
- Any persistent storage schema change (e.g. SQLite tables/columns/indexes) MUST include a migration path for existing on-disk data. If using `CREATE TABLE IF NOT EXISTS`, you must also `ALTER TABLE` / backfill as needed (or introduce explicit schema versioning) and add a regression test that starts from an older schema to prove upgrades work.
- DO NOT use the following characters in text intended for humans: `“`, `”`, `‘`, `’`, and other non-standard characters humans wouldn't type with a standard QWERTY keyboard.