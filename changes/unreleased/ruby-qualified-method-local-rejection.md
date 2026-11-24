---
section: Fixed
---

Ruby qualified method calls no longer resolve to class-body locals. Calls without a proven method target remain unresolved with partial method reference coverage, while the unrelated local keeps its own references and rename edits.
