---
section: Fixed
---

Swift conformances, inheritance clauses, and type annotations that name a type with extensions now resolve to the type's declaration, including a `private` or `fileprivate` type in its own file, instead of staying unresolved or naming an extension header. An extension header is no longer a member of its type, so the extended type's name inside its own extension no longer resolves to that header when the project does not declare the type.
