---
section: Fixed
---

Swift go-to-definition, references, call edges, and impact again resolve a call on a concrete type to the witness or override when its parameter type spells an associated type, `Self`, or a generic parameter differently from the requirement or base member (`put(_ i: Int)` for `put(_ i: Item)`, `same(as other: V)` for `Self`, `add(_ x: Int)` for `Base<T>`, including an override in a further subclass). A same-name overload whose parameter type is a different concrete type still competes. A keyword in a declaration header, such as `func` next to `var count` and `func count(of:)`, names that declaration instead of a same-named property.
