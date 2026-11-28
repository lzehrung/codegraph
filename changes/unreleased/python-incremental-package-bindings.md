---
section: Fixed
---

Warm Python builds (`codegraph index`, `codegraph sync`, agent sessions, and the `buildProjectIndexIncremental` and cached `buildProjectIndex` library functions) now rebind a `from pkg import name` import the way a cold build does after the submodule or namespace package directory it bound is deleted, after a module is added to a namespace package, and after `pkg/__init__.py` gains or loses the attribute `name`. Before, until the importer itself changed, a disk-cache update kept its bindings to deleted submodules, disk-cache builds missed modules added to a namespace package, and memory-cache updates and cached full builds kept the submodule after the initializer defined the attribute. In any language, a disk-cache update now also re-resolves an importer that reached a deleted file only through an import binding, not a dependency edge.
