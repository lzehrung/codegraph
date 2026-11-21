---
section: Fixed
---

C# detailed graphs keep the `calls` edge of `T.Static()` when the calling type has a field, property, or local typed `T`, as go-to-definition and references already resolved it. A field, local, or parameter named like its own type (`Widget Widget`) still calls the instance method of that type.
