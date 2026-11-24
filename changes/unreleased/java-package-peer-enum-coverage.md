---
section: Fixed
---

An unresolved Java switch label now makes references to a matching enum constant in another proven same-package file partial, even when the enum declaration is its only verified reference. Rename previews remain unsafe instead of offering a declaration-only rename that leaves the label behind.
