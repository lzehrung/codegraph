---
section: Fixed
---

Unresolved explicit receiver calls that may name a Ruby top-level method now keep its references partial and its rename preview unsafe, instead of silently omitting the call from complete coverage.
