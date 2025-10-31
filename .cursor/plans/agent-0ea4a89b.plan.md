<!-- 0ea4a89b-dc84-4d8a-90d4-5f1392dca266 6947c2dd-6aad-4fe1-96f6-26e77f386b43 -->
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

### To-dos

- [ ] Add symbolId and defFromSymbolId to indexer.ts
- [ ] Implement resolveSymbolId for ::import (named/default/namespace)
- [ ] Add goToDefinitionById and findReferencesById wrappers
- [ ] Implement listSymbols(index, { file?, includeImports? })
- [ ] Export new APIs from src/index.ts
- [ ] Document handle-based usage in README with concise examples