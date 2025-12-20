---
name: Agent-friendly symbol handles (no line/column)
overview: ""
todos:
  - id: dc25e021-ccf3-4979-a336-8a0344fbb1eb
    content: Add symbolId and defFromSymbolId to indexer.ts
    status: pending
  - id: fd29267e-22e0-4c9b-b9a0-b7f9722c17ae
    content: Implement resolveSymbolId for ::import (named/default/namespace)
    status: pending
  - id: b0405347-bfca-4075-9e08-79aa1fb1ce2a
    content: Add goToDefinitionById and findReferencesById wrappers
    status: pending
  - id: 655e4c41-7dae-458f-9ed2-d3c5931d288a
    content: Implement listSymbols(index, { file?, includeImports? })
    status: pending
  - id: d09273da-1ea6-44d9-9ef2-ff0474c7c57a
    content: Export new APIs from src/index.ts
    status: pending
  - id: 27a56e79-64ee-4d51-84d9-1685bcb8cb5c
    content: Document handle-based usage in README with concise examples
    status: pending
---

# Agent-friendly symbol handles (no line/column)

### What we'll add

- Stable SymbolHandle format and helpers:
- `symbolId(def: SymbolDef): string` → `${file}::${localName}::${startIndex}`
- `defFromSymbolId(index, id): SymbolDef | null`
- Import handle resolution (alias to def):
- Recognize `${file}::${alias}::import` for named/default/namespace imports
- Resolve via existing `resolveImported`/`resolveExport` with namespace → first export fallback
- Wrapper navigation APIs (no line/column):
- `goToDefinitionById(index, id)` → `GoToResult`
- `findReferencesById(index, id)` → delegates to `findReferences({ def })`
- Lightweight enumeration for agents:
- `listSymbols(index, { file?, includeImports? })` → locals (+ optional import aliases) with handles
- README examples for agent usage with handles

### Files to change

- `src/indexer.ts`: add handle helpers, id resolution, wrappers, `listSymbols`
- `src/index.ts`: export new APIs
- `README.md`: add “Agent-friendly navigation with handles” examples

### Notes

- Ambiguity policy: when resolving imports/namespace, auto-pick per existing behavior (local → import → export where applicable; namespace picks first export).
- Backwards compatible; no changes to existing APIs.