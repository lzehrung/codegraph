---
section: Fixed
---

Sorted results and cached representatives (references, rename edits, affected tests, discovered project files, graph output, and a Go package's entry file) use en-US collation instead of the process locale, so output under locales such as Czech, Slovak, Albanian, or Thai matches other systems; en-US output is unchanged.
