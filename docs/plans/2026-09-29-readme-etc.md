# Plan 1: README, hotspots description, and documentation and quality features

Date: 2026-09-29. Status: proposed.

## Goals

- Make the README a shorter landing page that names the four jobs: review, refactor, quality, docs.
- Fix the wrong `hotspots` description.
- Add two reports that reuse indexed data: undocumented public API, and unused exports.

## Non-goals

- Do not delete CLI commands. Default help already shows 7 of 50 (`CORE_COMMAND_NAMES` in `src/cli/command-catalog.ts`).
- Do not add complexity or control-flow work here. See Plan 2.

## Work item A: README edits

Files: `README.md`. Update the table of contents in the same change (`AGENTS.md`).

1. Add one line near the top: codegraph is not an AST, not a compiler, and not a linter. Keep the existing tagline.
2. Regroup "What you can do" (lines 65-78) by job: review, refactor, quality, docs. Mark `refactor-plan` and `rename-preview` as read-only evidence.
3. Remove the repeated install text. Keep lines 22-39. Reduce "Try it" (lines 84-125) to a link to `docs/installation.md`.
4. Cut "Using as a library" (lines 325-408) to one example. Link to `docs/library-api.md` for the rest.
5. Make command prefixes consistent. Lines 77 and 175 use `node ./dist/cli.js links`. Use `codegraph links` if `links` is published. Check the release history first.
6. Decide the audience. If agents stay primary, add one sentence for human workflows.

Acceptance: README is shorter, the table of contents matches its sections, and no link is broken. Run `node ./dist/cli.js links --root .` to check.

## Work item B: fix the `hotspots` description

Problem: `src/cli/command-catalog.ts:51` and `src/cli/help.ts:671` say "Find high-complexity files". `getHotspots` in `src/graphs/hotspots.ts:53` takes only the file `Graph` and ranks by fan-in and fan-out.

Steps:

1. Change both strings to describe fan-in and fan-out ranking, for example "Find the most-connected files".
2. Search `docs/`, `README.md`, `codegraph-skill/codegraph/SKILL.md`, and `src/mcp` for "complexity" next to "hotspot". Fix each match.
3. Update `docs/cli.md` and `SKILL.md` if they repeat the wrong wording (`AGENTS.md`).
4. Add a help-text test that the description does not claim complexity.
5. Add an `[Unreleased]` changelog line: help text corrected.

## Work item C: undocumented public API report

Data already indexed: `docstring`, `visibility`, export status (`SymbolNode`, `apisurface`).

Steps:

1. Decide the surface. Prefer an option on `apisurface`, for example `--undocumented`, over a new command. Reason: `AGENTS.md` says to recommend direct primitives.
2. Filter exported symbols with no docstring. Report file, name, kind, and range.
3. State which languages capture docstrings. Test each supported language. Use `docs/language-parity.md` to record any language that does not.
4. Give a pretty formatter and a JSON shape, with a pretty-output test.
5. Update `docs/cli.md`, `SKILL.md`, `docs/language-parity.md`, and `docs/scenario-catalog.md`.

Tests: one fixture per language with a documented and an undocumented export. Assert both are classified correctly (inclusion and exclusion).

## Work item D: unused exports

No command exists today. This is the riskiest item.

Rules:

- Report an export only when `refs` coverage is `complete` for that symbol. Otherwise omit it or mark it `partial` with a reason.
- Treat package entry points, `exports` fields, and re-exports as used.
- Never claim dead code. Word the result "no references found in the indexed project."

Steps:

1. Prototype as a library function over the existing reference index. Measure cost on this repository.
2. If cost is acceptable, expose it as an `apisurface` option or a `quality` report. Do not ship it until false positives are measured on real fixtures.
3. Fixtures: an unused export, a used export, a re-exported symbol, an entry-point export, a dynamically loaded module.
4. Update the same docs as item C.

## Order

1. B (small, a bug fix).
2. A (docs only).
3. C.
4. D, after C ships and the false-positive rate is known.

## Verification

- `npm run test:integration` for help and CLI output.
- `npm run check` before merge.
- Every change includes its docs and `[Unreleased]` entry where user-visible.
