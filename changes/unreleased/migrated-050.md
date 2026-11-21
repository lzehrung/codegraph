---
section: Fixed
---

Ruby: the detailed graph records `calls` edges for calls nested in arguments, receivers, and blocks (`sink(tick())`, `[1].each { tick }`, `foo(Bar.new)`), and for a bare name that is no local (`sink(num)`, `puts num`, `[1].map { |q| q + num }`) when `self` has that method there. A name that a block parameter shadows stays a local read.
