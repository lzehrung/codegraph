---
section: Fixed
---

Ruby instance calls on a fresh constructor result (`Svc.new.run`, `item = Svc.new; item.run`, and `self.run` in an instance method) resolve in classes that also declare class methods (`def self.other`), where they were unresolved while the method's references claimed to be complete. Where the file shows a `new` of the class's own or of a superclass (`def self.new`, `alias_method :new, :build`, `define_singleton_method(:new)`), which may return another object, the call stays unresolved and the method's references are partial.
