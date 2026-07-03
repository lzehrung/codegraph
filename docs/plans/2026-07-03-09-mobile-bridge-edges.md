# Mobile bridge edges

## Goal

Add conservative cross-language graph edges for mobile/native bridge boundaries so Codegraph can trace flows that cross source-language files through explicit bridge declarations.

## Initial scope

Do not implement every bridge at once. Start with one high-value, parser-visible bridge shape:

- Swift `@objc` exposed methods referenced from Objective-C message sends.

Follow-up bridge families can be separate PRs:

- React Native legacy modules
- React Native event emitters
- Expo modules
- Fabric/Paper view components

## Design

Introduce a bridge-synthesis pass after normal per-language symbol extraction and before final graph edge materialization.

```ts
type SynthesizedEdge = {
  from: string;
  to: string;
  label: "references" | "calls";
  provenance: "heuristic";
  synthesizedBy: string;
  confidence: "high" | "medium" | "low";
  metadata?: Record<string, string | number | boolean>;
};
```

Edges must be tagged. Never make synthesized bridge edges indistinguishable from parser-direct edges.

## Swift/ObjC vertical slice

Extraction:

- Index Swift methods with explicit `@objc` names.
- Index Swift methods with implicit ObjC selector candidates only when exposure is clear.
- Index Objective-C message sends and method declarations if Objective-C support exists in the same PR. If Objective-C is not yet supported, limit this PR to Swift-side metadata and tests that prove no false graph claims are emitted.

Resolution:

- Match explicit `@objc(name:)` first.
- Match class-qualified receivers when available.
- Skip ambiguous selector matches.
- Record `synthesizedBy: "swift-objc-bridge"`.

## Non-goals

- No dynamic runtime dispatch inference.
- No reflection/string selector inference.
- No broad React Native support in this PR.
- No low-confidence edges in default graph output unless explicitly requested.

## Files likely touched

- `src/indexer/types.ts`
- `src/graphs/symbol-graph.ts`
- `src/languages/definitions/swift.ts`
- new `src/graphs/synthesized-edges/mobileBridge.ts`
- `packages/codegraph-native/src/languages.rs` only if adding Objective-C grammar support
- `docs/language-parity.md`
- `docs/scenario-catalog.md`
- tests under `tests/languages/swift.test.ts` and new bridge-specific tests

## Tests

- explicit `@objc(foo:)` maps to matching selector.
- ambiguous selector candidates are skipped.
- synthesized edge has provenance and confidence metadata.
- graph consumers can distinguish synthesized edges.
- no bridge edges are emitted when only one side is present.

## Acceptance

- Bridge edges improve cross-file impact without hiding uncertainty.
- Every synthesized edge explains how it was created.
- Unsupported bridge families remain documented as non-goals.

## Review pass

Checked scope: this plan chooses one conservative bridge vertical slice and requires provenance on every synthetic edge. It avoids turning dynamic runtime behavior into unqualified graph facts.
