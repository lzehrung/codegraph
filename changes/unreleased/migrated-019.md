---
section: Fixed
---

Go-to-definition returns `not_found` with the native node or depth projection limit instead of throwing. Find-references reports `parser_degraded` when an unprojectable file is a candidate or included in a receiver scan; same-language files, and JavaScript, TypeScript, TSX, Vue, and Svelte files across that family, are also candidates when their Bloom filters cannot rule out the name, an equivalent spelling, or an exported name. For an exported JavaScript-family definition, `import`, `require`, or `export` tokens also make an unprojectable file a candidate because it may use an alias; missing filters and unprobeable spellings remain candidates too. Tree-based go-to-definition still throws for other native parse failures and files over the native byte limit; the projection-limit failure is remembered for that content across queries and warm builds, and the limits are unchanged.
