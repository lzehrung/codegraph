---
section: Fixed
---

Ruby: a rename preview of a reader is unsafe when a compound assignment (`item.total += 1`, `item.total ||= 2`) also calls a writer that the rename leaves behind. An `attr_accessor` rename stays unsafe, as its symbol declaration cannot be edited as text.
