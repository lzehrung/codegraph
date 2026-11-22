---
section: Fixed
---

Ruby: `self.name = value` and `object.name = value` call the writer `name=`, not the reader `name`, in navigation, references, and detailed call edges. A compound assignment (`+=`, `||=`) still names the reader.
