---
section: Fixed
---

C# private and ordinary static members remain independently renameable despite external bases; accessible instance members keep conservative interface checks. Rename previews also reject independently renaming proven abstract, virtual, and override member families, and overrides of unindexed base members including implicit `object` members.
