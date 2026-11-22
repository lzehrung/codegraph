---
section: Fixed
---

Swift navigation, references, and detailed graphs now distinguish argument labels, resolve nested type constructions and protocol defaults, and honor private member visibility. Contextual enum cases and leading-dot static members (`OptionSet` constants, static functions and variables) resolve from declared types, `self`/`Self`, call parameters, returns, assignments, switch subjects, and comparisons when the context is proven. Calls with defaults before required parameters, trailing closures (also after `await`), or variadics keep their targets, a parameter list with a parse error never rejects its callable, a subscript is no longer a call edge, and a receiver spelled like its member (`lock.lock()`) adds no call edge to the receiver variable.
