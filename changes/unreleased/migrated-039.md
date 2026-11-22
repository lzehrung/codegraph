---
section: Fixed
---

Swift member lookup reuses shared-owner paths and extension constraints within an index instead of rebuilding them at every call site, without changing navigation, references, or detailed graph edges.
