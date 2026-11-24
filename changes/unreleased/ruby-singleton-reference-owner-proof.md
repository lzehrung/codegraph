---
section: Fixed
---

Ruby module singleton methods (`def self.x` inside a module) report partial reference coverage and unsafe rename previews, because qualified calls such as `Mod.x` and visibility symbols such as `private_class_method :x` are not collected as references. Previously their references could claim complete coverage while omitting those sites.
