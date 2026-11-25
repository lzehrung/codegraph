---
section: Fixed
---

Ruby bare calls in a `class << self` body no longer resolve to the class's own singleton methods, which that body cannot call. A top-level, base-class, or mixin method that such a call, or an unproven class-body call, may still reach keeps partial references and an unsafe rename preview.
