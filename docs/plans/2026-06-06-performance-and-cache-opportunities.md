# Remaining performance cleanup candidates

Status: Needs decision. The original audit is complete enough to retire; merged work is preserved in Git history.

Measurement-only follow-ups moved to [the performance measurement backlog](2026-08-03-performance-measurement-backlog.md). The candidates below are the only unimplemented ideas not already owned by the active native-startup plan.

## Candidate-test reuse

Impact, review, coverage suggestions, and `affected` share test-file classification and candidate selection but still create some run-local matchers and candidate maps independently.

Possible outcome: introduce one prepared per-index or per-run test-candidate context reused by these consumers.

Decision risk: no current measurement shows this work is material, and `affected` already provides the direct test-selection workflow. Do not implement without a profile showing repeated classification or traversal dominates a representative impact or review run.

## Navigation lookup caches

Repeated `goto` and reference verification may revisit receiver, member, and local-scope lookups.

Possible outcome: add bounded snapshot-owned lookup caches for proven repeated resolver operations.

Decision risk: cache identity and invalidation complexity can exceed the saved work. The reference-candidate index and persisted Bloom filters already removed broader scans; measure the remaining semantic verification path first.

## Narrower detailed graph work in impact

Impact still requests detailed graph context for relevant changed files while some internal graph construction remains project-wide.

Possible outcome: construct only the detailed graph sections required by the changed-file context while preserving every reported edge, risk, candidate test, and omission count.

Decision risk: a narrower graph can silently change review output. Require full-output parity and a profile proving detailed graph construction remains a dominant impact phase.

## Decision

Review these three candidates as a group:

- Keep this plan only if at least one candidate has enough expected value to justify a measurement scenario.
- Otherwise delete it. The measurement backlog can create a new implementation plan later if evidence establishes a bottleneck.

Do not use unchecked items from the retired audit as an implementation queue.
