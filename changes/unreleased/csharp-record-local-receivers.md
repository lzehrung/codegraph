---
section: Fixed
---

C# member reads and calls resolve through explicitly typed locals, parameters, and fields whatever their initializer, and positional record property references and rename previews include those reads. Nearer binders, including deconstruction locals and anonymous-method parameters, do not inherit an outer receiver's type.
