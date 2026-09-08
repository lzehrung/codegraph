---
name: codegraph
description: "Use for repo structure, symbol navigation, dependency analysis, duplicate triage, and PR impact review when plain text search is too shallow."
---

# codegraph

Use Codegraph to find definitions, references, calls, dependencies, and change impact.
Use plain text search for exact strings, logs, config keys, and prose.
Codegraph provides static evidence, not runtime proof.

## Choose the next tool

Prefer mounted MCP tools for repeated queries; they share a warm index. Otherwise, use the CLI.
MCP accepts flat schema fields, not CLI flags or per-call roots.

| Need                                 | CLI                                                             | MCP                                |
| ------------------------------------ | --------------------------------------------------------------- | ---------------------------------- |
| Map an unfamiliar repo               | `codegraph orient --root . --budget small`                      | `orient`                           |
| Find a declaration by name           | `codegraph symbols "Name"`                                      | `workspace_symbols`                |
| Search across code, paths, and docs  | `codegraph search "query"`                                      | `search`                           |
| Find a definition                    | `codegraph goto <target>`                                       | `goto`                             |
| Find references                      | `codegraph refs <target>`                                       | `refs`                             |
| Find callers or callees              | `codegraph callers <handle>` / `codegraph callees <handle>`     | `calls`, with `direction`          |
| Find file dependencies or dependents | `codegraph deps <file>` / `codegraph rdeps <file>`              | `file_deps`, with `direction`      |
| Find a path between files            | `codegraph path <from> <to>`                                    | `path`                             |
| Find base or derived types           | `codegraph supertypes <target>` / `codegraph subtypes <target>` | `type_hierarchy`, with `direction` |
| Find implementations                 | `codegraph implementations <target>`                            | `implementations`                  |
| Read current source                  | `codegraph file <path> --offset 1 --limit 200`                  | `get_file`                         |
| Retrieve context for a known target  | `codegraph packet get <target>`                                 | `packet_get`                       |
| Resolve a search handle              | `codegraph explain <handle>`                                    | `get_symbol`                       |

CLI `goto` / `refs` accepts `file:line:column`, project-relative `file::symbol`, or returned `symbol:` handles.
MCP takes separate `file`, `line`, `column` fields, or `handle`; do not mix forms or invent handles.
Use `codegraph refs <file>` to check every definition in a file.
`deps`, `rdeps`, and `file_deps` accept symbol handles but traverse the declaring file.

## Follow the task, not the catalog

### Find and understand code

1. Known target: use `goto`, `refs`, or `get_file`. Use `orient` only if you need a repo map.
2. Find declarations with `workspace_symbols` / `codegraph symbols`; use `search` for broader queries.
3. Read source, then follow `refs`, `calls`, or `file_deps`. File dependencies are not symbol calls.

`explore` / `codegraph explore "query"` combines one search with context from its top results; it does not plan subqueries.
MCP omits source unless `includeSource: true`; CLI includes it unless `--no-source`.

### Review changes

Start with the compact review report:

```bash
codegraph review
codegraph review --base origin/main --head HEAD
```

These review staged and unstaged edits, and branch changes, respectively.
MCP `review` and `impact` require explicit `base` and `head`.
Use `codegraph impact --base HEAD --head WORKTREE` for wider dependency impact.
Review and impact ranges select changes, not the indexed project scope.

Get candidate test paths with `codegraph affected --base HEAD --head WORKTREE --quiet`, then run the relevant tests.

### Plan a refactor

Resolve the symbol, then inspect `refs`, callers, or implementations.
Use `codegraph refactor-plan <handle>` / MCP `refactor_plan` for references, calls, hierarchy, and candidate tests from one snapshot.
For renames, use `codegraph rename-preview <target> <new-name> --json` / MCP `rename_preview`, or add `--rename <new-name>` to `refactor-plan`.

These tools do not edit source.
Treat `safe: false` (nested `rename.safe` in refactor plans), conflicts, unsafe sites, omissions, and `sectionIssues` as blockers until checked.
Filename results are suggestions only.

## Keep results small and check their limits

- Use readable CLI output for direct reading; `--json` for exact fields, ranges, handles, or tool chaining. Do not parse display text.
- Use narrow queries and small limits. `codegraph search --no-snippets` avoids source you will read separately.
- Check `truncated`, `omitted`, and `omittedCounts`. A capped result is incomplete; narrow the query or raise its limit.
- Dependency, call, and type hierarchy queries default to depth 1. Increase depth for transitive results.
- For `file` / `get_file`, offsets are 1-based; continue at `page.nextOffset`. Request indexed context with `--include-graph-context` / `includeGraphContext: true`.
- Calls and type relationships are proven indexed edges, not complete runtime coverage. Missing edges do not prove absence.
- Check backend warnings and `analysis` when present. `mixed` or `reduced` analysis has weaker symbol coverage.
- Duplicate matches, candidate tests, and compatibility hints are leads. Verify behavior with focused tests or execution.

## Scope, freshness, and sensitive files

- CLI `--root` sets the project boundary. Use project-relative paths; MCP uses the root fixed at server startup.
- Config globs are project-root-relative; CLI `--include-glob` / `--ignore-glob` filters are relative to each scan root. Use `--no-gitignore` only for deliberately included ignored files.
- Current-state CLI queries reuse and validate the disk index. `init`, `index`, and `sync` are not prerequisites.
- Check MCP `freshness`; on `stale`, run `refresh_index` and repeat the query. `artifact_build` requires fresh state and write access.
- Plain `get_file` / `codegraph file` reads live bytes; optional indexed context can be stale.
- Recognized sensitive files return summaries or metadata. Enable `--allow-sensitive` / `allowSensitive: true` only for deliberate raw access.

## Other tasks and recovery

- Architecture checks: `codegraph inspect`, `codegraph hotspots`, `codegraph cycles`, `codegraph unresolved`, and `codegraph apisurface`.
- Duplicate cleanup: `codegraph duplicates --root . ./src --profile cleanup`. Local Markdown links: `codegraph links --json`.
- Specialized reads: `codegraph grep --query` for syntax trees, `codegraph chunk` for embeddings, and `codegraph dumpmod` for indexed module data.
- Compare architecture across revisions: `codegraph drift` or `codegraph graph-delta`.
- Export graphs with `codegraph graph --json`; `codegraph viewer` is for people. Create bundles with `codegraph artifact build` / MCP `artifact_build`; query SQLite exports with `codegraph sql` / MCP `query_sqlite`.
- If MCP startup or transport fails, do not keep retrying that server. Run `codegraph doctor` and use the CLI for the session.
- First CLI queries may build an index; progress goes to stderr. Use `codegraph orient --report` to diagnose index costs.
- After a Codegraph update, restart or reload the owning MCP client. `refresh_index` refreshes project state, not running tool code.
- CLI exit `1` can mean findings, no target, or a runtime failure: read the output. Exit `2` means invalid usage or input.
- Preview setup with `codegraph install --dry-run`. Do not overwrite user config, delete reported cache paths, or stop unrelated processes automatically.

## Look up details only when needed

Use `codegraph help <command>` for flags and `codegraph help advanced` for the full catalog.
Use mounted MCP schemas for exact field names and limits.
The CLI package is `@lzehrung/codegraph`, not the unscoped `codegraph` package.

- [CLI reference](https://github.com/lzehrung/codegraph/blob/main/docs/cli.md)
- [MCP reference and server setup](https://github.com/lzehrung/codegraph/blob/main/docs/mcp.md)
- [Installation](https://github.com/lzehrung/codegraph/blob/main/docs/installation.md)
- [Agent workflows and library sessions](https://github.com/lzehrung/codegraph/blob/main/docs/agent-workflows.md)
