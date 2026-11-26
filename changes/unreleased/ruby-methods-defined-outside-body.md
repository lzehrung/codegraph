---
section: Fixed
---

Ruby references of a method defined on an object from outside a class body (`def Foo.bar`, `def klass.bar`) now include its direct receiver calls (`Foo.bar`), also from other files, and module singleton methods (`def self.x` in a module) list the qualified calls and visibility symbols that name them while keeping partial coverage. A call through a subclass (`Sub.bar`) is still not listed. A call on an untyped local (`o.greet` after `def o.greet`) leaves those references partial, and a class method that the file also defines from outside its body (`def self.bar` beside `def Foo.bar`) keeps partial references and an unsafe rename preview.
