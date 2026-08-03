# Semantic graph synthesizers

Status: Planned. Build one shared provenance contract and one concrete vertical slice before adding another framework family.

## Goal

Model parser-visible framework semantics that ordinary imports and calls miss while keeping every inferred node and edge conservative, auditable, and optional.

## Shared contract

A synthesizer runs after normal symbol extraction and before graph finalization. It consumes indexed symbols, imports, locals, and already-available source context; it must not create a second parser pipeline.

Every synthesized fact must include:

- a stable synthesizer id
- `provenance: "heuristic"`
- confidence
- a human-readable reason
- concrete source ranges and endpoints

Emit a fact only when the framework convention is stable and ambiguity can be resolved. Skip dynamic names, runtime dispatch, reflection, and ambiguous matches; low-confidence facts must not appear in default graph output.

Synthesized facts may participate in search, path, references, dependencies, impact, review, packets, and explain only when those surfaces preserve provenance and omission counts.

## Candidate vertical slices

Pick one slice for the first pull request.

### Framework routes

- Express-style JavaScript/TypeScript routes with literal paths and a concrete final handler.
- FastAPI-style Python decorators with a literal path and the decorated function as handler.
- Create route nodes such as `GET /users/:id` plus references to handlers and explicit middleware.
- Skip dynamic paths and ambiguous handler expressions.

### Mobile bridges

- Start with explicit Swift `@objc` names matched to Objective-C selectors.
- Require Objective-C source support before emitting a cross-language edge; Swift-only indexing may retain metadata but must not claim a bridge.
- Match class-qualified receivers when available and skip ambiguous selectors.
- Defer React Native, Expo, Fabric, and Paper families.

### Dispatch conventions

- Start with either Redux Toolkit Query endpoint declarations mapped to generated hooks or Redux thunk dispatch references.
- Require both endpoints to be concrete symbols or locally declared framework keys.
- Do not infer generic event buses, dependency injection, or arbitrary string dispatch.

## First-slice implementation

1. Define the shared synthesized-fact and provenance schema without changing parser-direct facts.
2. Add one synthesizer and positive, negative, renamed, and ambiguous fixtures.
3. Integrate the fact into the smallest relevant query surfaces.
4. Prove disabling synthesis removes the facts without changing ordinary graph output.
5. Update `docs/language-parity.md` and `docs/scenario-catalog.md` with the exact framework and limitations.

## Acceptance

- One concrete framework pattern works end to end.
- Every emitted fact explains how and where it was derived.
- Ambiguous and dynamic cases produce no false graph claims.
- Existing graph output remains backward compatible or receives an explicit schema version.
- The shared contract can host a second slice without a parallel framework or provenance shape.
