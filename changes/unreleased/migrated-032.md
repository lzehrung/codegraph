---
section: Fixed
---

Swift `previewRename` of a protocol property requirement now renames the property each conforming type declares (declared conformance, extensions, refining protocols) with its uses, and reports `safe: false` when a witness cannot be proven. Renaming a witness alone is unsafe, and a same-named property on a type that does not conform stays out.
