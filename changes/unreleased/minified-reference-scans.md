---
section: Fixed
---

`findReferences`, `findRenameReferences`, and `rename_preview` no longer repeat the same unresolved-import scan for every script that an HTML page loads, so references to short names in minified vendor scripts (for example jQuery bundled in generated documentation) are about seven times faster on such projects, with identical results and coverage.
