---
section: Fixed
---

C# attribute names resolve to the class with the `Attribute` suffix (`[Marker]` and `[Marker()]` reach `MarkerAttribute`), and references of an attribute class include those uses. A name that matches an attribute class with and without the suffix is ambiguous unless written `@Marker` or `MarkerAttribute`; rename previews mark the suffix-less spelling unsafe.
