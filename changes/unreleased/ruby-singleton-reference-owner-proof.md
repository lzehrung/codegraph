---
section: Fixed
---

Ruby module singleton methods (`def self.x` inside a module) report partial reference coverage and unsafe rename previews instead of complete coverage that omitted qualified calls such as `Mod.x` and visibility symbols such as `private_class_method :x`.
