# AGENT DIRECTIVES

## General

- Never use `any` or `as unknown as`
- Never use nested ternary expressions. Use `if`/`else`, a helper function, or named intermediate values instead.
- Never use `=== true`, `=== false`, etc. in boolean conditions; keep them as terse and simple as possible like `!condition`. Extract conditions to variables when the variable name adds clarity/insight into the reason for the condition.
- In boolean condition contexts, use the shortest syntactically equivalent expression. Prefer `items.length` over `items.length > 0`, `!items.length` over `items.length === 0`, and `items?.length` over `items && items.length > 0`.
- Always consider the impact of a change on tests or when more test cases are needed. Never make tests pass for the sake of passing; always exercise real behavior.
- Always keep documentation updated and accurate while being minimal and concise.
- Keep paragraphs to no more than 3 concise sentences. Prefer bullets for dense details.
- Keep `README.md` as the landing page and docs index. Do not turn it back into the only canonical reference for every example and workflow.
- When public-facing install, runtime, CLI, library API, agent workflow, or release guidance changes, update the relevant canonical docs in the same change: `README.md`, `docs/installation.md`, `docs/cli.md`, `docs/library-api.md`, `docs/agent-workflows.md`, `docs/how-it-works.md`, and `PUBLISHING.md` as applicable.
- Within any claimed cross-language capability, behavior should stay consistent across all supported languages for that capability. Avoid language-subset branches; if a limitation is intentional, document it in the parity docs and cover it with explicit tests in the same change.
- When language support changes, update `docs/language-parity.md` and `docs/scenario-catalog.md` in the same change so support claims, limitations, and fixture coverage stay aligned.
- When adding or changing a cross-file language scenario, add or update the nearest language test in `tests/languages/*.test.ts` and the shared semantic coverage in `tests/goto.test.ts`, `tests/references.test.ts`, and `tests/native-semantic-parity.test.ts` when the language uses the native runtime.
- Always keep the README.md table of contents updated whenever README sections are added, removed, or renamed.
- When CLI commands, flags, or output contracts change, update both `docs/cli.md` and `codegraph-skill/codegraph/SKILL.md` in the same change.
- Always keep `codegraph-skill/codegraph/SKILL.md` updated when CLI commands, flags, or capabilities change. This file is the skill definition used by agents and must reflect the current tool surface.
- Any persistent storage schema change (e.g. SQLite tables/columns/indexes) MUST include a migration path for existing on-disk data. If using `CREATE TABLE IF NOT EXISTS`, you must also `ALTER TABLE` / backfill as needed (or introduce explicit schema versioning) and add a regression test that starts from an older schema to prove upgrades work.
- DO NOT use curly quote variants or other non-standard characters humans would not type with a standard QWERTY keyboard.
