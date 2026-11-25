---
section: Fixed
---

`findReferences`, rename previews, and CLI `refs` return `not_found` instead of a parser error for a JSON module target, including one reached through a JavaScript or TypeScript import, and MCP `refs` returns its normal empty result instead of an execution error. Go-to-definition still resolves the JSON module.
