---
section: Fixed
---

Ruby local-variable references and rename previews include command-shaped operand reads such as `total -1`, `total -x`, `total &mask`, `total *scale`, and `total [1]`. Explicit method calls remain separate, and unmodeled operand binders keep reference coverage partial and rename previews unsafe.
