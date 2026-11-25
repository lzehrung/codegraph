---
section: Fixed
---

`findReferences` and rename previews scan a document once per requested name instead of once per unresolved import, so references to short names in minified scripts that HTML pages load (for example jQuery in generated documentation) are about seven times faster, with identical results and coverage.
