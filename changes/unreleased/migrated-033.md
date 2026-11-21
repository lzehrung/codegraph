---
section: Fixed
---

Swift `findReferences` and `previewRename` of a function, method, or initializer parameter no longer count the member after a dot that spells the same (`self.title = title`, `o.title`), so renaming the parameter leaves the property alone and the code still compiles. A requirement rename whose protocol has more conforming types than the walk lists now reports `safe: false` at once, instead of after finding the uses of the types it did list.
