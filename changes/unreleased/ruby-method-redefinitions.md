---
section: Fixed
---

Each `def` token of a redefined Ruby method names its own definition, and the token of `def name=` names that writer rather than a reader `def name`, so references and rename previews no longer mix the declarations. Calls through a type name reach its last class method of that name (or a class-body local's same-named singleton method). In a class whose file declares it and its whole heritage, and that no other file opens and the file does not show sharing its levels, bare calls in method bodies and in blocks that keep `self` reach only a method of their own `self` level. Where code runs between two same-level definitions, both keep partial references and an unsafe rename preview.
