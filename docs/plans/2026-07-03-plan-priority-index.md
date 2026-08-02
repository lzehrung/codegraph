# Plan priority and status

This is the live index for plans that still need a decision or implementation. Completed and superseded plans are removed because Git history and merged pull requests preserve their implementation record.

## Next

These plans describe current, executable work:

1. `2026-07-28-explore-first-query-ranking-tuning.md`
   - Improve natural-language ranking, explore composition, and candidate-test selection.
2. `2026-07-25-performance-program-index.md`
   - Keep the shared performance baseline and coordinate the remaining Git and native-startup work.
3. `2026-07-25-git-subprocess-elimination.md`
   - Continue the measured work after implemented priorities 0 and 1.
4. `2026-07-25-native-runtime-startup.md`
   - Reduce native fingerprint and startup costs after validating installed-user impact.

## Planned

These plans are unimplemented and remain distinct product outcomes:

- `2026-05-27-agent-test-plan-generation.md`
- `2026-07-03-03-shared-server-lifecycle.md`
- `2026-07-03-08-framework-route-nodes.md`
- `2026-07-03-09-mobile-bridge-edges.md`
- `2026-07-03-10-dispatch-synthesizers.md`
- `2026-07-03-12-affected-tests-command.md`
- `2026-07-03-14-privacy-preserving-diagnostics.md`
- `2026-07-03-16-config-extension-mapping.md`

The affected-tests plan has an old open implementation in PR #146. Reconcile that branch against current `main` before treating it as executable work.

## Needs reconciliation

These plans mix completed work, overlapping scope, or measurement-gated follow-ups. Do not implement or delete them until the remaining outcome is restated:

- `2026-05-12-graph-first-language-expansion.md`
  - Consolidate with `2026-07-03-11-source-language-expansion.md` into one language-expansion owner.
- `2026-07-03-11-source-language-expansion.md`
  - Preserve the narrow vertical-slice guidance when consolidating language work.
- `2026-06-06-performance-and-cache-opportunities.md`
  - Most ranked work shipped; move only still-validated gaps into the performance program.
- `2026-07-21-warm-run-discovery-avoidance.md`
  - Priorities 1-4 and audit ranks 1-3 shipped; decide whether the remaining stretch items still justify ownership.

## Deferred or rejected

- A check-only `upgrade` command is rejected because the name implies an update that it would not perform.
- Any future `upgrade` must execute channel-specific updates, confirm unless `--yes`, stream and propagate subprocess results, verify the resulting version, and safely handle permissions, dirty or detached source trees, and Windows runtime locking.
- More language count, graph UI work, and new CLI commands remain lower priority until current semantic quality and primary workflows justify them.

## Status rules

- Every new plan must appear here as `next`, `planned`, `blocked`, or `needs reconciliation`.
- A plan leaves this index when its outcome is merged, explicitly rejected, or superseded.
- Completed and superseded plan files should be removed instead of retained as a second roadmap.
