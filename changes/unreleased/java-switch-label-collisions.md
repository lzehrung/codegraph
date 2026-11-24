---
section: Fixed
---

Java switch labels no longer guess between a same-named constant field and a reachable enum constant when the subject's type is unproven. These sites stay unresolved, references report partial coverage, and rename previews stay unsafe; declared enum subjects select their enum's constants, while ordinary integer labels without a collision retain their field targets.
