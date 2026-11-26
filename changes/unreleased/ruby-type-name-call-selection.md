---
section: Fixed
---

A Ruby call through a type name (`Foo.baz`) now selects the method that type reaches when its file has several same-named methods (`class << Foo; def baz` beside another class's `def self.baz`), where it was unresolved while the method's references claimed to be complete. It no longer resolves to an instance method of a class, which only its instances run, unless the class may answer the call with it (a superclass or mixin the file does not declare, `method_missing`, or a `class << self` call naming the method), nor to a top-level `def self.baz`.
