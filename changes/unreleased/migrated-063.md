---
section: Fixed
---

PHP constant reads resolve in PHP's namespace order: the current namespace and then the global namespace for an unqualified name, with no fallback for `\NAME`, `namespace\NAME`, or a qualified name. Reads in other files, in parameter defaults, and through `use const` resolve, a same-named constant of an unrelated namespace is never chosen, `findReferences` lists the reads, and `findUnusedExports` no longer reports a used constant. Several constants that compete for one read leave it unresolved with partial reference coverage, so none of them is reported unused.
