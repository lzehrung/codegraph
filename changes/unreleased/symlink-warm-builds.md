---
section: Fixed
---

A `disk` update or warm full rebuild now lists the files a symlink reaches as a cold build does: files added, removed, or restored below a symlinked directory, a link whose target was deleted, restored, or retargeted inside or outside the project root, and a link that returns after its target was missing. Before, an update kept a module whose link target was gone, missed files added below a link, and a warm full build could miss a link that was removed and restored. A session update no longer fails with `Incremental file is outside project root` after a link is retargeted outside the project, and a `--cache-strict` update drops a tracked or untracked file that became a link to a path outside it. Manifests record every symlink instead of a symlinked-directory hint, and existing disk caches rebuild once after upgrading.
