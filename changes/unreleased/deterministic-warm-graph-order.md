---
section: Fixed
---

`buildProjectIndex`, `buildProjectIndexIncremental`, and `listProjectFiles` order files, modules, and graph edges by file path, whatever found the files or whether a cache served them. A `memory` or `disk` build after an edit, delete, rename, or restore now matches a cold build of the same files; before, an updated `disk` index listed the changed files last, and a project found by a filesystem scan could list its files differently from run to run. Existing disk caches rebuild once after upgrading.
