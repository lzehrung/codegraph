---
section: Fixed
---

PHP navigation, references, and call edges select a method a class gets through a nested trait (a trait that uses another trait, at any depth) over an inherited method of the same name, as PHP does: the class's own method, then the methods of its traits, a trait's own method before the traits it uses, then inherited methods. This holds through `$this`, `self::`, `static::`, `parent::`, constructed receivers, and type names. When a class composes a trait that no indexed declaration names, such as a vendor trait, a name that the indexed traits do not declare stays unresolved, with the reference coverage reason `unindexed_trait`, instead of selecting an inherited method. A method named like its class or a composed trait (`$this->deep()` inside `class Deep`) is no longer hidden by the declaration of that class or trait.
