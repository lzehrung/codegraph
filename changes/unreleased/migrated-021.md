---
section: Fixed
---

A build reuses one Git repository check and one repository-anchor lookup instead of repeating `rev-parse` and `.git` probes for the same root.
