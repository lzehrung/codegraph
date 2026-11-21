---
section: Fixed
---

TypeScript and TSX now parse adjacent generic call signatures without semicolons, so a later type alias resolves in go-to-definition and references instead of disappearing under a parse error. Split generic methods, including optional/modified signatures and decorated or static class methods, keep their callable identity and argument counts instead of selecting an inherited namesake or becoming a field; construct signatures and invalid class-method modifiers are not recovered as methods. Cross-file navigation, references, detailed calls, and rename edits retain the own declaration; interface rename previews remain safe, while class recovery keeps references partial and rename unsafe because of a missing-name parse error. Ordinary property signatures are unchanged, and both cached indexes and search-sidecar chunks rebuild with the pinned grammar.
