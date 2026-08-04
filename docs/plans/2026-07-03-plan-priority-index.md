# Plan priority and status

This is the live index for plans that still need a decision or implementation. Completed and superseded plans are removed because Git history and merged pull requests preserve their implementation record.

## Next

1. `2026-08-04-mcp-sdk-v2-migration.md`
   - Move to the official split MCP v2 server packages and serve modern plus legacy protocol eras.
2. `2026-07-25-performance-program-index.md`
   - Keep the shared performance baseline and coordinate the remaining native-startup work.
3. `2026-07-25-native-runtime-startup.md`
   - Reduce native fingerprint and startup costs after validating installed-user impact.

## Planned

- `2026-05-12-source-language-expansion.md`
- `2026-07-03-03-shared-server-lifecycle.md`
- `2026-07-03-semantic-graph-synthesizers.md`
- `2026-07-03-14-privacy-preserving-diagnostics.md`
- `2026-08-03-performance-measurement-backlog.md`

## Deferred or rejected

- A check-only `upgrade` command is rejected because the name implies an update that it would not perform.
- Any future `upgrade` must execute channel-specific updates, confirm unless `--yes`, stream and propagate subprocess results, verify the resulting version, and safely handle permissions, dirty or detached source trees, and Windows runtime locking.
- More language count, graph UI work, and new CLI commands remain lower priority until current semantic quality and primary workflows justify them.

## Status rules

- Every new plan must appear here as `next`, `planned`, `blocked`, or `needs decision`.
- A plan leaves this index when its outcome is merged, explicitly rejected, or superseded.
- Completed and superseded plan files should be removed instead of retained as a second roadmap.
