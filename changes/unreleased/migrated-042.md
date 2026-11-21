---
section: Fixed
---

Swift calls keep a lone same-name function or member as the target when its argument count or labels do not fit, through `self`, `super` (labels only), an implicit receiver, a typed value, or a type, whether it is declared on the receiver's type or inherited from a base class, so impact analysis still reports a changed signature or label rename. A wrong label rejects a candidate only when overloads at the nearest declaring level compete; when the labels fit none of them, the overload whose argument count fits is chosen, and the call stays unresolved when the count does not single one out. A leading-dot call (`.make(1)`) resolves to a static function or a function-valued variable, never to a variable that holds a value; a call edge to a property is recorded only when its declaration is a function type or closure; and a pattern, condition, or closure binding that a bare read may name no longer resolves to a same-named property or method.
