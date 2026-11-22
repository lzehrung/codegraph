---
section: Fixed
---

Ruby: a class, module, or `class << self` body keeps its own local variables, and a `def` sees no local of the code around it, as in Ruby 3.3; blocks still close over the locals around them. A name the syntax binds as a local (multiple assignment, pattern, `rescue => e`, `for`, lambda parameter, named capture) is never a method.
