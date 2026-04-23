# System Review Issues

- [x] Make full SQLite graph exports idempotent and remove stale rows on rewrite.
  Acceptance criteria:
  Full `writeGraphSqlite` rewrites replace prior graph state instead of appending duplicate edges or retaining deleted files/symbols.

- [ ] Make impact streaming internally consistent and incrementally useful.
  Acceptance criteria:
  `changedSymbol` events respect scope filtering before emission, and impacted items are yielded incrementally instead of only after the full analysis completes.

- [ ] Unify library logging and observability behavior under `logLevel` and structured reports.
  Acceptance criteria:
  Library code does not emit uncontrolled `console.warn` noise on normal paths when `logLevel: "silent"` is requested, and important degradations remain observable through reports or explicit error surfaces.

- [ ] Fail explicitly on invalid project roots and discovery failures instead of returning silent empty indexes.
  Acceptance criteria:
  invalid or unreadable roots raise actionable errors, while legitimate empty projects remain distinguishable from discovery failures.

- [ ] Surface native worker bootstrap failures in diagnostics/reporting.
  Acceptance criteria:
  when worker startup fails, callers can determine why from the structured build report instead of seeing a silent fallback.

- [ ] Do a final review pass after fixes and capture any remaining risks or improvement opportunities.
