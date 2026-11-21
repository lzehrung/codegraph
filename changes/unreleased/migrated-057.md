---
section: Fixed
---

The MCP HTTP server now requires `hono` 4.13.16 or later, which fixes middleware bypasses through `mount()` and the RegExp router (GHSA-4m76-xfj5-7975, GHSA-h7mg-cq63-vhpq), a `csrf()` gap for hyperlink-auditing requests (GHSA-46wx-v44x-9hh2), skipped `multipart/form-data` validation (GHSA-4h7h-rv7c-7m2v), and unescaped closing tags in the `css` helper (GHSA-3gg2-335m-rxc6).
