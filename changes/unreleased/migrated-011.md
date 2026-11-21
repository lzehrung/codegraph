---
section: Fixed
---

Java enum switch labels use declared enhanced-for and `instanceof` variables and enum-typed fields selected through `this` or a proven receiver. C# expression variables stay within their `foreach`, `while`, or switch-expression arm scopes; positional record properties reached through proven receivers are included in references and rename edits, with partial coverage for unproven reads. Swift tuple-pattern and enum-payload labels no longer become references or rename edits of same-named locals or parameters.
