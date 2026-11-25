---
section: Fixed
---

C# discard designations (typed `out int _`, deconstruction and pattern discards) are no longer indexed as locals and do not hide a same-named field `_` in references and rename previews; an untyped `out _` still names an in-scope `_`.
