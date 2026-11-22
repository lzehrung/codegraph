---
section: Fixed
---

Result and cache ordering no longer depends on the process locale: sorted references, affected files, graph output and cached representatives (such as a Go package's entry file) use en-US collation everywhere, so output under Czech, Slovak, Albanian or Thai locales now matches other systems. Existing en-US output is unchanged.
