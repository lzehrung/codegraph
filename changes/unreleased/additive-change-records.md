---
section: Changed
---

Contributors record release notes and cache changes in separate append-only files instead of editing shared changelog sections or epoch counters. Release preparation deterministically assembles and consumes changelog fragments; build-generated cache identities include every merged epoch entry across library, core-package, and bundled CLI builds. Existing caches rebuild once after upgrading.
