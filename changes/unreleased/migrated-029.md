---
section: Fixed
---

C# record positional parameters and C# 12 primary-constructor parameters, and Java record components, resolve inside their own type in go-to-definition, references, and call edges. Nearer binders and members take precedence; initializers and base-constructor arguments read the parameter, and an unproven designator or binder stays unresolved with partial coverage. A parameter named like its own type (`record R(Outer Outer)`) is not bound, so `Outer.Static`, nested types, and enum members keep reading the type. A base-constructor argument is no longer an `implements` edge.
