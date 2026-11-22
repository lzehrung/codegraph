---
section: Fixed
---

TypeScript, TSX, and JavaScript find-references finds a default-parameter or destructuring-default read (`a = K`), `type B = A`, a shorthand property use (`{ name }`) of an import, a name forwarded through `import { X } from "./x"; export { X }` barrels, and the alias token of `export { X as Y }`. JSDoc type references (`@param {X}`, `{@link X}`) are still not read as references. Rename previews of a name exported through such a barrel now include the importers' edits, and edit a shorthand property use (`{ X }`) as `{ X: Renamed }` so the property key stays. A rename through a default-import barrel (`import D from "./x"; export { D }`) stays unsafe, because the downstream names are the importers' own.
