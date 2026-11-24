---
section: Fixed
---

An unresolved Java switch label no longer makes constant fields in unrelated same-package classes have partial references and unsafe rename previews. Package-peer uncertainty remains limited to enum constants: a constant field in another same-package file that the label could name, such as a superclass field, is not downgraded to partial by this rule.
