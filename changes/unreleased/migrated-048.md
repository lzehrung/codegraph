---
section: Fixed
---

Ruby: a bare name reaches a method declared in a class or module only from that type, or from a type its superclasses and mixins connect to in the same file, so a method of an unrelated class in the file no longer binds it in go-to-definition, references, or the detailed graph. A method of the type around the use wins over one of a base, mixin, or includer declared later.
