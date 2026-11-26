---
section: Fixed
---

A Ruby method redefined in a reopened body of the same class in one file now follows the redefinition rule: when code runs between the definitions, both have partial references and an unsafe rename preview, and a call in a method body resolves to the later definition when it replaces the first before any code runs. A body opened under a condition (`class C ... end if ready?`) is not treated as part of the class, and a method it redefines keeps partial references.
