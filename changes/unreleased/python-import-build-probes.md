---
section: Changed
---

Index builds of Python projects (`codegraph init`, `codegraph index`, `codegraph sync`, and the `buildProjectIndex` and `buildProjectIndexIncremental` library functions) resolve each imported module once per importing directory, list each package directory once to find submodules, and read each package `__init__.py` once, instead of repeating that work for every import statement; import bindings and answers are unchanged. A cold build of a 3,487-file Python project made 922 `statSync` and 158 `readdirSync` calls instead of 15,993 and 8,212 and took 10.7 s instead of 14.1 s with one native worker. An update after an edit to that project's top-level package `__init__.py` took 13.8 s instead of 17.1 s.
