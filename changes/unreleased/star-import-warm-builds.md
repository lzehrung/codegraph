---
section: Fixed
---

Warm builds (`codegraph index`, `codegraph sync`, agent sessions, and the `buildProjectIndexIncremental` and cached `buildProjectIndex` library functions) no longer fail with `TypeError: Cannot add property ..., object is not extensible` after a PHP file listed in Composer `autoload.files` gains a function, and star imports (Python `from pkg import *`, Composer `autoload.files`, C includes, JVM and C# wildcards) bind the names their targets export at that build. Before, a memory-cache build kept names a target no longer exported and appended new ones out of order. Disk-cache builds now re-resolve a CommonJS `require` in a TypeScript file once the file it names is added, and every warm build extracts again the PHP files a composer.json governs once a file its `autoload.files` lists is added or restored.
