---
section: Fixed
---

Swift protocol requirements are members of their protocol, so a bare name, an argument label, or a pattern or closure binding in another file no longer resolves to a requirement of the same spelling, and `findReferences` for a property requirement lists its uses through protocol-typed receivers. Members used inside an extension also see what the extended type inherits from its base class or refined protocols, and the members of `Q` (or of each protocol of `Q & R`) in `extension P where Self: Q`. A variadic parameter (`xs: Item...`) holds an array, so a member after it no longer resolves to a member of `Item`.
