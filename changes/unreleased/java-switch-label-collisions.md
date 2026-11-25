---
section: Fixed
---

Java switch labels no longer guess between a same-named constant field and a reachable enum constant when the subject's type is unproven: the label stays unresolved, and the references of both candidates, including an enum constant declared in another same-package file, report partial coverage with unsafe rename previews. Declared enum subjects still select their constants, and declared integral, `String`, and boxed selectors keep their constant-field targets.
