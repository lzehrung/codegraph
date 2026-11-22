---
section: Fixed
---

TypeScript and TSX type parameters bind to their own declaration: a use inside a call or construct signature, method signature, function type, function, class, interface, or type alias resolves to its `<T>` instead of a same-named outer type, and references of that outer type exclude it. A value of the same spelling (`import * as R` beside `<R>`) still resolves to the value. Variance modifiers (`in T`, `out T`, `in out T`) parse as errors in the pinned grammar, and the parameter's real name still binds. Mapped-type keys (`[K in keyof T]`) and `infer` names are not modeled: with no outer type of that spelling they resolve to nothing, and with one the outer type answers for them.
