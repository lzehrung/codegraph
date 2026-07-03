# Affected tests command

## Goal

Add a direct CLI command that maps changed source files to likely affected test files for local development and CI scripts.

Command:

```bash
codegraph affected src/auth.ts src/db.ts
codegraph affected --stdin --quiet
codegraph affected --base main --head HEAD --json
```

## Design

Build on existing impact/candidate-test logic. Do not invent a second dependency graph.

Inputs:

- positional files
- `--stdin` for newline-delimited file paths
- `--base`/`--head` to derive changed files from git diff
- `--root`
- `--filter <glob>` to restrict test files
- `--depth <n>` for reverse dependency traversal depth
- `--json`
- `--quiet` for paths only

## Algorithm

1. Normalize changed files relative to `--root`.
2. Build or load project graph/index with existing cache options.
3. For each changed file, traverse reverse dependencies up to depth.
4. Classify test files using existing test-file detection/candidate-test helpers.
5. Include directly changed test files even if no source file maps to them.
6. Sort deterministically by path.

## JSON output

```ts
type AffectedTestsReport = {
  schemaVersion: 1;
  root: string;
  changedFiles: string[];
  affectedTests: Array<{
    file: string;
    reasons: string[];
    depth: number;
  }>;
  omittedCounts: Record<string, number>;
};
```

## CLI output

Default pretty output:

```text
Affected tests
- tests/auth.test.ts (reverse dependency from src/auth.ts, depth 1)
```

`--quiet` prints only paths, one per line.

## Files likely touched

- `src/cli/help.ts`
- `src/cli/options.ts`
- `src/cli.ts`
- new `src/cli/affected.ts`
- `src/impact/report-suggestions.ts` or shared test-candidate helper extraction
- `docs/cli.md`
- `README.md`
- `codegraph-skill/codegraph/SKILL.md`
- tests under new `tests/affected.test.ts`

## Tests

- positional source file maps to direct test.
- transitive reverse dependency maps to test within depth.
- `--depth 0` only includes changed tests.
- `--stdin` reads paths.
- `--filter` limits results.
- `--base`/`--head` uses git provider safely.
- `--quiet` prints stable paths only.
- JSON schema is stable.

## Acceptance

- CI can run `codegraph affected --stdin --quiet` and pipe results into a test runner.
- Review/impact candidate-test behavior is reused, not forked.
- Output is deterministic and root-relative.

## Review pass

Checked scope: this plan exposes a simple command over existing graph and test-candidate logic. It avoids duplicating impact analysis while adding a useful scripting interface.
