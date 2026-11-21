---
section: Fixed
---

Ruby: `findReferences` finds the uses of methods named with `?` or `!` (`ready?`, `save!`). Before, the reference prefilter probed the whole spelling, which no file holds as one token, and skipped every file. `ready` and `ready?` stay distinct methods, and a caller that never requires the declaring file keeps `partial` coverage for them.
