---
section: Fixed
---

Java and C# member selectors no longer count as references of same-named locals or parameters. C# member and argument designators resolve through proven owners, and initializer-local `out` and pattern variables no longer leak into other members; unproven designators stay unresolved.
