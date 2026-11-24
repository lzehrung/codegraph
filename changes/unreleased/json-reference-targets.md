---
section: Fixed
---

Return `not_found` instead of a parser error when `findReferences` or CLI `refs` targets a JSON module, including through a JavaScript or TypeScript import. MCP `refs` returns its normal empty-result response instead of an execution error. JSON module identity remains available to go-to-definition.
