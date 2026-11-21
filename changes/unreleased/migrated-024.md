---
section: Fixed
---

Ruby receiver-qualified method selectors and C member/designated-initializer field names no longer count as references or rename edits of same-named local variables, parameters, or free functions. Rust qualified item names keep references and rename edits for functions, constants, and statics (`super::shared()`, `self::f()`, `crate::LIMIT`, `inner::K`, `Self::CONST`); only variable-like bindings are excluded at item-name segments, while namespace qualifiers reject value bindings. Swift call argument labels stay out of local references and rename edits, while their argument expressions and member receivers remain real reads.
