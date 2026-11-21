---
section: Fixed
---

`codegraph init` and `codegraph sync --init` in a Git subdirectory warm the same cache that later commands reuse, without leaving an unused cache namespace at the repository root.
