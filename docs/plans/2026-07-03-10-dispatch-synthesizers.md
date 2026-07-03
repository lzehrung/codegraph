# Dispatch synthesizers

## Goal

Model common explicit dispatch patterns that static import/call extraction misses, while keeping every inferred edge conservative and provenance-tagged.

## Initial scope

Start with one low-risk pattern already common in TypeScript projects:

- Redux Toolkit Query endpoint declarations to generated hook/use-site references, or
- Redux thunk dispatch references.

Pick one pattern for the PR. Do not add a generic heuristic engine that claims arbitrary dynamic dispatch.

## Design

Add a small synthesizer framework:

```ts
type GraphSynthesizer = {
  id: string;
  languages: string[];
  collect(snapshot: ProjectIndex): SynthesizedEdge[];
};
```

Synthesizers run after symbol extraction and before graph finalization. They receive indexed symbols, imports, locals, and source snippets where already available.

All edges emitted by synthesizers must include:

- `provenance: "heuristic"`
- `synthesizedBy`
- `confidence`
- `reason`

## Quality bar

A synthesizer may emit an edge only when:

- both endpoints are concrete symbols or files
- the pattern has a stable framework convention
- ambiguity is resolved or the edge is skipped
- tests cover negative cases

Do not emit edges for string names unless the framework convention requires string keys and the key is locally declared.

## Output integration

Synthesized edges should participate in:

- `path`
- `deps`/`rdeps` where file-level edges are affected
- `impact`
- `review`
- `packet_get`
- `explain`

Pretty output should mark synthesized/heuristic edges where relevant.

## Files likely touched

- `src/graphs/symbol-graph.ts`
- `src/indexer/types.ts`
- new `src/graphs/synthesizers/index.ts`
- one concrete synthesizer file
- `src/agent/packet.ts`
- `src/impact/report*.ts` if provenance needs display
- `docs/language-parity.md`
- `docs/scenario-catalog.md`
- tests under new `tests/dispatch-synthesizers.test.ts`

## Tests

- positive fixture emits expected edge.
- renamed/ambiguous fixture emits no edge.
- generated edge has provenance metadata.
- path traversal can use synthesized edge.
- impact report includes synthesized dependency with clear reason.
- disabling synthesizers, if supported, removes the edge.

## Acceptance

- One concrete dispatch pattern is supported end to end.
- The framework is extensible without encouraging broad unproven heuristics.
- Every inferred edge remains auditable.

## Review pass

Checked scope: this plan keeps dynamic-dispatch support evidence-driven. It adds one proven synthesizer and a small framework rather than a broad inference engine.
