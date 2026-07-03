# Framework route nodes

## Goal

Represent common web route declarations as graph nodes linked to handler symbols so Codegraph can answer route-to-handler and handler-to-route questions.

## Initial scope

Implement one vertical slice first:

- Express-style JavaScript/TypeScript routes:
  - `app.get("/x", handler)`
  - `router.post("/x", handler)`
  - middleware chains ending in handler
- FastAPI-style Python routes:
  - `@app.get("/x")`
  - `@router.post("/x")`

Do not implement every framework in one PR.

## Design

### Data model

Add route nodes to the symbol graph:

```ts
type RouteNode = {
  id: string;
  kind: "route";
  file: string;
  name: string;        // GET /users/:id
  method?: string;
  pathPattern: string;
  range: SourceRange;
  metadata: {
    framework: "express" | "fastapi";
    confidence: "high" | "medium";
  };
};
```

Edges:

- route -> handler with label `references`
- handler -> route only if existing reverse traversal derives it from incoming edges; do not duplicate reverse edges unless the graph model requires it.

## Extraction

Add route extraction after normal symbol extraction, using parser-backed captures where possible.

Express:

- identify member calls where property is an HTTP method.
- first argument must be a string literal route path.
- handler is the last function-like argument or identifier argument.
- middleware identifiers can be recorded as additional references with metadata.

FastAPI:

- identify decorated function definitions.
- decorator call property/name is HTTP method.
- first argument string literal is route path.
- decorated function is handler.

## Output integration

Route nodes should appear in:

- `search` when querying route paths or handler names.
- `packet_get` for handler symbols as incoming references.
- `refs` for handlers.
- `graph --symbols-detailed`.
- `impact` and `review` when handler changes.

## Files likely touched

- `src/graphs/symbol-graph.ts`
- `src/indexer/types.ts`
- language-specific extraction under `src/languages/definitions/typescript.ts`, `javascript.ts`, `python.ts`
- `src/agent/search.ts`
- `src/agent/packet.ts`
- `docs/language-parity.md`
- `docs/scenario-catalog.md`
- tests in `tests/languages/*.test.ts`, `tests/goto.test.ts`, `tests/references.test.ts` where applicable

## Tests

- Express route creates route node and handler reference edge.
- Express middleware chain links final handler and records middleware metadata.
- FastAPI decorator creates route node and handler reference edge.
- handler `refs` includes route declaration.
- `search "GET /users"` returns route node.
- unsupported dynamic route path is skipped or marked low confidence; do not fabricate.

## Acceptance

- Route extraction is conservative and provenance-tagged.
- Existing graph output remains backward-compatible or schema-versioned if changed.
- Docs clearly state initial framework coverage and limitations.

## Review pass

Checked scope: this plan starts with two high-value framework shapes and avoids broad heuristic claims. It integrates routes into existing symbol/reference surfaces instead of creating a separate route subsystem.
