---
section: Fixed
---

Go-to-definition, find-references, and the detailed graph find the innermost scope around a name by searching the file's scopes in source order instead of testing every scope of the file for each name, and a TypeScript type parameter is recognised when a use needs it instead of being recorded on every binding. The detailed graph build of large TypeScript projects (Hono, Zod) is faster than before the type-parameter work, with identical answers.
