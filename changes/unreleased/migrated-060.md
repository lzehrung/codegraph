---
section: Fixed
---

PHP function and method calls ignore declaration letter case, namespaced class uses choose the right class, `parent::` calls reach ancestor methods, and using classes resolve ordinary trait methods and uniquely composed promoted properties. Full-project `use` declarations retain their imported targets. Abstract trait requirements defer to concrete class or parent methods; adapted trait calls cannot fall through to a same-named inherited method. Multiply used trait properties stay conservative.
