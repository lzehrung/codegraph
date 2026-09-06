# AGENT DIRECTIVES

## General

- Never use `any` or `as unknown as`
- Never use nested ternary expressions. Use `if`/`else`, a helper function, or named intermediate values instead.
- Never use `=== true`, `=== false`, etc. in boolean conditions; keep them as terse and simple as possible like `!condition`. Extract conditions to variables when the variable name adds clarity/insight into the reason for the condition.
- In boolean condition contexts, use the shortest syntactically equivalent expression. Prefer `items.length` over `items.length > 0`, `!items.length` over `items.length === 0`, and `items?.length` over `items && items.length > 0`.
- Always consider the impact of a change on tests or when more test cases are needed. Never make tests pass for the sake of passing; always exercise real behavior.
- Always keep documentation updated and accurate while being minimal and concise.
- Add a concise `[Unreleased]` entry for user-visible behavior, CLI output, support, compatibility, or user-facing fixes. Skip test-only, internal refactoring, and formatting-only changes; state why in the PR when omitted.
- Keep paragraphs to no more than 4 concise sentences. Prefer bullets for dense details.
- Keep `README.md` as the landing page and docs index. Do not turn it back into the only canonical reference for every example and workflow.
- When public-facing install, runtime, CLI, library API, MCP, agent workflow, or release guidance changes, update the relevant canonical docs in the same change: `README.md`, `docs/installation.md`, `docs/cli.md`, `docs/library-api.md`, `docs/mcp.md`, `docs/agent-workflows.md`, `docs/how-it-works.md`, and `PUBLISHING.md` as applicable.
- Public PR titles, bodies, comments, and release notes MUST NOT include local paths, machine names, usernames, shell prompts, worktree details, or session details. Describe portable commands and observed behavior instead.
- For repo-understanding flows, start with `node ./dist/cli.js doctor` and `node ./dist/cli.js orient --root . --budget small --json` when `dist` is built; build first if validating the working tree from a fresh checkout.
- For source-checkout validation and contributor examples, prefer `node ./dist/cli.js ...`; reserve bare `codegraph ...` for published/global install guidance.
- When package metadata, install scripts, optional native dependencies, or the resolved npm graph changes, update `package-lock.json` in the same change and verify with `npm ci --ignore-scripts --dry-run` unless lifecycle scripts are part of the behavior under test. Release-candidate package installs MUST also disable lifecycle scripts unless those scripts are under test.
- Treat `--root` as the project boundary for config lookup, path confinement, and output normalization. Cache/manifests may use the resolved cache anchor (`--cache-dir`/`CODEGRAPH_CACHE_DIR`, repository metadata, or project root); cached contents remain project-relative.
- Keep discovery glob guidance accurate: `codegraph.config.json` globs are project-root-relative, while CLI `--include-glob`/`--ignore-glob` values are one-off filters relative to each active scan root.
- Within any claimed cross-language capability, behavior should stay consistent across all supported languages for that capability. Avoid language-subset branches; if a limitation is intentional, document it in the parity docs and cover it with explicit tests in the same change.
- When language support changes, update `docs/language-parity.md` and `docs/scenario-catalog.md` in the same change so support claims, limitations, and fixture coverage stay aligned.
- When adding or changing a cross-file language scenario, add or update the nearest language test in `tests/languages/*.test.ts` and the shared semantic coverage in `tests/goto.test.ts`, `tests/references.test.ts`, and `tests/native-semantic-parity.test.ts` when the language uses the native runtime.
- Always keep the README.md table of contents updated whenever README sections are added, removed, or renamed.
- Human-readable CLI output is a public contract. User-facing `writeCliOutput(...)` callsites must provide a command-specific formatter unless the output is intentionally scalar or JSON-first, and the same change should add or update a pretty-output test.
- Progress MUST identify the active operation. Show a count only when it is meaningful; do not report zero progress for work with no measurable total.
- When CLI commands, flags, or output contracts change, update both `docs/cli.md` and `codegraph-skill/codegraph/SKILL.md` in the same change.
- Always keep `codegraph-skill/codegraph/SKILL.md` updated when CLI commands, flags, or capabilities change. This file is the skill definition used by agents and must reflect the current tool surface.
- Documentation and tool descriptions MUST name the exact CLI command, MCP tool, or exported API. Do not replace it with vague nouns such as "orientation", "navigation", or "targeted search".
- Describe aggregate operations precisely: name the first-pass retrieval and derived context, and state when planning, subquery decomposition, or runtime proof is absent. Do not describe parser/backend quality as query reasoning.
- Recommend direct primitives before bounded aggregators. Do not label an aggregate tool as the first step when exact symbol, reference, call, or file-dependency tools apply.
- Keep each surface role-specific: help and tool descriptions give the selection rule; CLI/API docs give the contract; skills give command order. Avoid repeating tutorials across surfaces.
- Distinguish library/session-only features from CLI/config features explicitly. If a capability exists only in exported library APIs, docs and types must say so, and CLI/config surfaces must not imply support they do not implement.
- When changing MCP notification, transport, or progress behavior, verify both the protocol seam and the serving seam users actually hit (HTTP/stdio); do not assume protocol-level behavior survives a transport wrapper unchanged.
- Before major commits or concluding work, run `npm run check` to verify formatting, lint, build, and tests together. During iteration, use the narrowest meaningful test command: targeted Vitest suites for localized changes, `npm run test:fast` for broader TypeScript changes, `npm run test:integration` for CLI/report/output contracts, and `npm run test:native` when touching `packages/codegraph-native`.
- Installation guidance must use `@lzehrung/codegraph` and the `@lzehrung` GitHub Packages registry. Keep detailed install docs in `docs/installation.md`.
- Any persistent storage schema change (e.g. SQLite tables/columns/indexes) MUST include a migration path for existing on-disk data. If using `CREATE TABLE IF NOT EXISTS`, you must also `ALTER TABLE` / backfill as needed (or introduce explicit schema versioning) and add a regression test that starts from an older schema to prove upgrades work.
- DO NOT use curly quote variants or other non-standard characters humans would not type with a standard QWERTY keyboard.
- Duplicate-tokenizer fingerprints must not shift with the toolchain. The TypeScript and native
  identifier grammars are pinned to one Unicode version: the native side through the exact
  `unicode-ident` pin in `packages/codegraph-native/Cargo.toml`, the TypeScript side through the
  generated `src/duplicate-identifier-ranges.ts`. Never resolve that grammar with a Unicode
  property escape, which follows the host Node build's Unicode version. Changing the crate pin
  means rerunning `npm run generate:duplicate-identifier-ranges` and bumping
  `DUPLICATE_TOKENIZER_REVISION` in the same change, so cached duplicate units tokenized by the
  previous grammar are recomputed instead of surviving `DUPLICATE_UNIT_CACHE_MAX_AGE_MS`.
- `packages/codegraph-native/Cargo.lock` is committed because the crate ships prebuilt binaries.
  Update it in the same change as any `Cargo.toml` dependency edit.

## Path, Cache, and Review Safety

- Path-bearing code MUST keep the requested logical root, resolved physical root, and owning Git
  repository distinct. Use logical paths for output, cache-relative values, and caller-facing
  results; use physical paths only for confinement and symlink validation.
- A path from Git MUST be classified as absolute or relative before resolving it. Preserve Git's
  path spelling when the Git cwd is an alias, and test aliases to repository roots and subdirectories.
- Git ignore changes MUST respect `.gitignore`, repository and configured excludes, nested
  submodule boundaries, source precedence, ignored ignore files, and directory rules. Extend the
  existing matcher rather than adding a second one, and test logical and physical paths.
- If a derived cached field changes behavior, invalidate existing snapshots by version or by
  fingerprinting every new input. Legacy snapshot migration MUST drop or recompute affected
  derived fields rather than relabel stale data as current.
- Before extracting an archive, validate its verified location, entry paths, and entry types.
  Reject links and special files before extraction. Report a missing executable as an environment
  failure, not invalid input.
- A worker-pool test MUST build `dist` first and verify the actual worker path. A bare
  `npx vitest run` can silently disable workers when the compiled worker file is absent.
- After resolving review feedback, run the focused regression and require a fresh clean review
  plus green CI after any rebase before merging. Do not treat a prior review as current after
  the branch changes.
