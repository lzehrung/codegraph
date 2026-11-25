---
section: Fixed
---

Ruby calls on another constant, such as `DontCall.new` inside a class or module that defines `self.new`, no longer resolve to the enclosing type's singleton method in navigation, references, and rename previews. They reach that constant's own method (including `def Foo.bar` or a `def` in `class << Foo` outside its body), a body reopening it, or a superclass or mixin the file gives it, and otherwise stay unresolved.
