---
section: Fixed
---

Ruby calls through a type name (`Square.new`, `Right.make`) no longer reach a class method of a sibling class or a subclass, and bare calls no longer reach a sibling class's method, in navigation, references, and rename previews. A base class still reaches a method its subclass declares by bare name, and a mixin one of another mixin of the same class.
