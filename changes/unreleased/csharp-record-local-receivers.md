---
section: Fixed
---

C# member reads and calls now resolve through explicitly typed locals, parameters, and fields regardless of initializer. Positional record property references and rename previews include these proven reads; nearer binders and unmodeled deconstructions or anonymous-method parameters do not inherit an outer receiver's type.
