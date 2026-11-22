---
section: Fixed
---

Ruby: `attr_reader`, `attr_writer`, and `attr_accessor` under `private`, `protected`, or `public` (`private attr_reader :balance`) are indexed like unwrapped ones, so a bare `balance` reaches the accessor of its own class. A form the index cannot read (`memoize attr_reader :x`, `private attr_reader(*NAMES)`) defines nothing and leaves a bare name unresolved, never bound to a same-named method of another class.
