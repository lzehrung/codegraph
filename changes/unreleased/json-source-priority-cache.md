---
section: Fixed
---

Previously resolved relative JSON imports refresh their cached targets when a higher-priority ignored source appears, changes physical target, or disappears; content-only edits to that source do not re-extract its importers.
