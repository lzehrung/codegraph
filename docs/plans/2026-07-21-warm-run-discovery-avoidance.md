# Non-Git warm discovery fallback

Status: Needs decision. Git-backed warm discovery, freshness reuse, symlink-walk avoidance, scoped inspect/review caching, and detailed-symbol-graph persistence are implemented and preserved in Git history.

## Remaining outcome

Non-Git projects and strict verification paths still require exhaustive discovery. A possible fallback would persist directory mtimes and skip globbing subtrees whose membership cannot have changed.

The design would need:

- explicit manifest schema versioning and an older-schema migration regression
- a periodic exhaustive verification fallback
- documented behavior for network, cloud-sync, overlay, and bind-mounted filesystems whose directory mtimes may be unreliable
- `--cache-verify` as an unconditional exhaustive path
- proof that additions, removals, renames, symlink changes, and ignored-path changes cannot be missed

## Value gate

Do not implement this from the historical warm-run measurements. Git reconciliation now covers the primary repository workflow, while the non-Git fallback adds persistent state and correctness risk.

Keep this plan only if [the performance measurement backlog](2026-08-03-performance-measurement-backlog.md) demonstrates that representative non-Git projects spend material time in discovery and identifies a reliable target filesystem contract. Otherwise delete it.
