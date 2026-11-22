---
section: Fixed
---

Queries that encounter a file with a recorded projection-limit failure now check its content after a stat change, reporting a stale-source error only when the content changed. Timestamp-only changes are checked once and reuse the recorded failure.
