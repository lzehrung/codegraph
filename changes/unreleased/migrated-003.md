---
section: Fixed
---

Repeated reference and rename lookups reuse identifier spellings within the query-cache memory budget, dropping spelling tables before parsed views and avoiding table construction without enough headroom. Shared member lookups reuse each module's normalized declaration names without changing navigation, coverage, or detailed graph answers.
