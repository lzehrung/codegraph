---
section: Fixed
---

Warm disk and memory builds reuse unchanged JSON candidate records, with shared-candidate checks linear in importer count. Missing or invalid records are rebuilt without re-extracting cached modules, while Vue and Svelte stylesheet imports retain their targets and no longer trigger repeated extraction when a same-stem JSON file exists.
