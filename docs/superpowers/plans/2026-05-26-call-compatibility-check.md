# Call Compatibility Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add conservative cross-language call compatibility hints to impact and review output so Codegraph can flag likely arity mismatches after a changed callable signature.

**Architecture:** Build a provider-based signature/callsite sidecar on top of existing symbol metadata and `calls` edges. Emit `likely_mismatch` only when the changed symbol, resolved callsite, and argument count are all high confidence; otherwise emit `unknown` or no hint.

**Tech Stack:** TypeScript, Vitest, existing Tree-sitter/native extraction, `buildSymbolGraphDetailed()`, impact/review report types, CLI JSON and pretty renderers.

---

## Context

Codegraph already has diff impact and review reporting. This plan does not replace that feature. It adds a narrower signal: changed function or method signatures that likely no longer match resolved callsites.

Scope decision:

- Do not merge call compatibility as a public feature if it only supports JS/TS-family syntax.
- Treat call compatibility as a cross-language capability with explicit provider coverage.
- Every Codegraph language with callable symbols and resolved calls must have one of:
  - A provider that emits high-confidence hints.
  - A documented, tested `unsupported` entry in the parity matrix.
  - A documented `not_applicable` entry when the language/runtime surface has no meaningful callable model in Codegraph.
- Do not broaden docs or CLI wording beyond the provider matrix.
- Prefer no hint over a low-confidence or language-subset mismatch claim.

Important current files:

- `src/indexer/types.ts`: shared symbol and module index types.
- `src/graphs/symbol-graph.ts`: detailed symbol graph with `calls` edges.
- `src/impact/types.ts`: public impact report data model.
- `src/impact/map.ts`: maps changed diff ranges to changed symbols and existing `signatureChanged` hints.
- `src/impact/analyzer.ts`: produces changed symbols and impacted items.
- `src/review.ts`: builds review bundles and optional symbol details/callsites.
- `src/impact/reportFull.ts`, `src/impact/reportCompact.ts`, `src/impact/report.ts`, `src/cli/impact.ts`, `src/cli/review.ts`: presentation surfaces.
- `tests/impact-signature.test.ts`, `tests/impact-analyzer.test.ts`, `tests/review.test.ts`, `tests/symbol-detailed-semantic.test.ts`: nearest regression suites.
- `docs/language-parity.md`, `docs/scenario-catalog.md`, `docs/cli.md`, `docs/library-api.md`, `docs/agent-workflows.md`, `codegraph-skill/codegraph/SKILL.md`: docs to update because this changes review/impact output contracts.

Relevant design constraints:

- Do not promise compiler-like type checking.
- Emit `likely_mismatch` only when callee resolution, signature parsing, and callsite argument counting are confident.
- Return `unknown` for dynamic calls, spread-only calls, unresolved callees, optional/rest-heavy signatures, macro-like language constructs, or unsupported language syntax.
- Prefer Tree-sitter/native AST node extraction over whole-file string scanning.
- Use source-text scanning only inside already-identified declaration or call-expression node ranges.
- Keep language-specific logic behind providers, not branches in the impact/review analyzer.

## Deliverable

Add optional compatibility data to changed symbols in impact and review JSON:

```ts
export interface CallCompatibilityHint {
  status: "likely_mismatch" | "compatible" | "unknown";
  reason:
    | "argument_count_below_minimum"
    | "argument_count_above_maximum"
    | "signature_or_callsite_unknown"
    | "compatible_argument_count";
  changedSymbolId: string;
  callsiteFile: string;
  callsiteRange: SourceRange;
  callerSymbolId?: string;
  expected: {
    minArgs: number;
    maxArgs: number | null;
    confidence: "high";
  };
  actual: {
    argCount: number;
    confidence: "high";
  };
}
```

Use `maxArgs: null` for rest-argument signatures. Do not emit `likely_mismatch` when `maxArgs` is `null`; rest signatures are compatible above the minimum.

The normalized model may need to grow as language providers are added:

- `minArgs`: minimum positional arguments required.
- `maxArgs`: maximum positional arguments accepted, or `null` for rest/variadic signatures.
- `requiredNamedArgs`: required named/keyword arguments when the language supports them.
- `optionalNamedArgs`: optional named/keyword arguments when the language supports them.
- `supportsNamedArgs`: whether callsites may satisfy parameters by name.
- `hasRest`: whether the signature accepts unbounded positional arguments.
- `hasKeywordRest`: whether the signature accepts unbounded keyword/named arguments.
- `receiverMode`: `implicit`, `explicit`, or `none`.
- `confidence`: `high` only for emitted hints.
- `unsupportedReason`: a stable reason for diagnostics when a provider declines a case.

## Acceptance Criteria

- `impact` and `review` JSON include `callCompatibility` only for changed callable symbols with resolved callsites.
- Pretty/summary output includes a short section only when at least one `likely_mismatch` exists.
- Existing `signatureChanged` hints remain intact.
- Provider coverage exists for every language where Codegraph claims callable signatures and resolved calls, or the language has an explicit documented/tested unsupported entry.
- Cross-language support claims are backed by tests in `tests/impact-call-compatibility/*.test.ts` plus integration tests in the nearest impact/review suites.
- Other languages do not receive false mismatch claims. They may receive no hints or `unknown` only when this is documented in the provider matrix.
- `docs/language-parity.md` and `docs/scenario-catalog.md` include the call compatibility support matrix in the same change.
- No `any`, no `as unknown as`, no nested ternaries, no `=== true` or `=== false`.

## Cross-Language Provider Architecture

Add a provider registry before broadening public output.

Files:

- Create: `src/impact/call-compatibility/providers/index.ts`
- Create: `src/impact/call-compatibility/providers/types.ts`
- Move or replace: `src/impact/callCompatibility.ts`
- Test: `tests/impact-call-compatibility/provider-registry.test.ts`

Provider contract:

```ts
export interface CallCompatibilityProvider {
  languageIds: readonly string[];
  extractSignature(request: ExtractSignatureRequest): CallableSignature | null;
  extractCallsite(request: ExtractCallsiteRequest): CallsiteArguments | null;
  limitations(): readonly CallCompatibilityLimitation[];
}
```

Registry rules:

- The analyzer asks the registry for a provider by `languageId`.
- Providers own all language-specific syntax decisions.
- Providers return `null` for unsupported, ambiguous, or low-confidence cases.
- The analyzer never falls back to name-only text matching.
- The analyzer emits diagnostics for skipped languages and skipped reasons.

Diagnostics to add:

- `callCompatibility.supportedLanguages`
- `callCompatibility.unsupportedLanguages`
- `callCompatibility.skippedByReason`
- `callCompatibility.unknownCallsites`
- `callCompatibility.emittedHints`

## Cross-Language Provider Matrix

Use this matrix as the implementation checklist. Each row needs parser-level tests, at least one impact/review integration test, docs parity coverage, and explicit unsupported cases.

- [ ] **JS/TS/JSX/TSX**
  - [ ] Support functions, arrows, callable variables, defaults, optionals, rest args, generic type syntax, and regex literal call args.
  - [ ] Return `null` for overload-only/type-only declarations unless a runtime implementation target is clear.
  - [ ] Add method support only when method changed symbols and receiver/callsite resolution are reliable.

- [ ] **Python**
  - [ ] Support functions and methods.
  - [ ] Handle `self`/`cls` receiver parameters.
  - [ ] Handle defaults, keyword calls, `*args`, and `**kwargs`.
  - [ ] Return `null` for dynamic splat/kwargs callsites that cannot be counted safely.

- [ ] **Go**
  - [ ] Support free functions and methods.
  - [ ] Account for receiver parameters as non-callsite arguments.
  - [ ] Handle variadic parameters.
  - [ ] Return `null` for unresolved selector calls.

- [ ] **Rust**
  - [ ] Support free functions, associated functions, and impl methods when references resolve.
  - [ ] Account for `self` receivers.
  - [ ] Handle turbofish syntax at callsites.
  - [ ] Return `null` for macros and unresolved trait-dispatch callsites.

- [ ] **Java**
  - [ ] Support methods and constructors.
  - [ ] Handle overloads conservatively.
  - [ ] Emit only when the changed symbol maps to an unambiguous callable target.

- [ ] **C#**
  - [ ] Support methods and constructors.
  - [ ] Handle optional parameters, named arguments, and `params`.
  - [ ] Handle overloads conservatively.

- [ ] **Kotlin**
  - [ ] Support functions, methods, constructors, default args, named args, and varargs.
  - [ ] Return `null` when default/named argument semantics make arity insufficient to judge.

- [ ] **Swift**
  - [ ] Support functions, methods, initializers, default args, argument labels, and variadics.
  - [ ] Treat labels as part of compatibility when confidence is high.

- [ ] **PHP**
  - [ ] Support functions and methods.
  - [ ] Handle defaults, named args, and variadics.
  - [ ] Return `null` for dynamic function/method calls.

- [ ] **Ruby**
  - [ ] Support methods where references resolve.
  - [ ] Handle optional args, keyword args, splats, double splats, and block args.
  - [ ] Return `null` for dynamic dispatch.

- [ ] **C**
  - [ ] Support unambiguous free functions and direct calls.
  - [ ] Handle prototypes vs definitions conservatively.
  - [ ] Return `null` for function pointers and macro calls.

- [ ] **C++**
  - [ ] Support unambiguous free functions first.
  - [ ] Add methods, constructors, templates, default args, and overloads only when resolution is reliable.
  - [ ] Return `null` for unresolved overload/template cases.

## Cross-Language Rollout Phases

- [ ] **Phase 1: Provider registry**
  - [ ] Introduce the provider contract and registry.
  - [ ] Move JS/TS logic behind the first provider.
  - [ ] Keep public docs conservative until the full matrix is ready.
  - [ ] Add diagnostics without changing human output claims.

- [ ] **Phase 2: Parity matrix**
  - [ ] Inventory all languages with callable symbols and resolved calls.
  - [ ] Update `docs/language-parity.md`.
  - [ ] Update `docs/scenario-catalog.md`.
  - [ ] Add a regression test that the docs matrix matches registered providers or explicit unsupported entries.

- [ ] **Phase 3: Provider implementation**
  - [ ] Implement lower-overload languages first: Python, Go, PHP, Ruby.
  - [ ] Implement method/overload-heavy languages next: Java, C#, Kotlin, Swift, Rust.
  - [ ] Implement C and C++ conservatively.
  - [ ] Add parser-level and integration tests with each provider.

- [ ] **Phase 4: Public feature gate**
  - [ ] Enable default `callCompatibility` output only after the matrix meets the merge bar.
  - [ ] Keep partial provider work internal or branch-only until then.
  - [ ] Run final review for parity drift and overclaiming.

## Merge Bar

- [ ] Every supported source language has a provider or a documented/tested unsupported entry.
- [ ] Public docs avoid language-subset claims unless the matrix explicitly says so.
- [ ] Pretty output emits only high-confidence likely mismatches.
- [ ] Structured output preserves diagnostics for unsupported and unknown cases.
- [ ] `docs/language-parity.md` and `docs/scenario-catalog.md` are updated.
- [ ] `npm run lint`, `npm run build`, `npm run test:ci`, and `git diff --check` pass.
- [ ] A final review pass finds no parity drift, no unsafe name-only matching, and no overclaiming.

## Task 1: Add Signature and Callsite Types

**Files:**

- Modify: `src/indexer/types.ts`
- Modify: `src/impact/types.ts`
- Test: `tests/impact-signature.test.ts`

- [ ] **Step 1: Add failing type-level fixture expectations**

Add a runtime test that imports the new public types and constructs representative objects. This catches export/type drift without relying on TypeScript-only assertions.

```ts
import type { CallCompatibilityHint } from "../src/impact/types.js";

it("models conservative call compatibility hints", () => {
  const hint: CallCompatibilityHint = {
    status: "likely_mismatch",
    reason: "argument_count_below_minimum",
    changedSymbolId: "src/api.ts#helper",
    callsiteFile: "src/main.ts",
    callsiteRange: {
      start: { line: 3, column: 10, index: 42 },
      end: { line: 3, column: 21, index: 53 },
    },
    callerSymbolId: "src/main.ts#run",
    expected: { minArgs: 2, maxArgs: 2, confidence: "high" },
    actual: { argCount: 1, confidence: "high" },
  };

  expect(hint.status).toBe("likely_mismatch");
  expect(hint.expected.maxArgs).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/impact-signature.test.ts
```

Expected: TypeScript/Vitest fails because `CallCompatibilityHint` is not exported.

- [ ] **Step 3: Add shared types**

In `src/impact/types.ts`, add `CallCompatibilityHint` near the changed-symbol report types. Reuse existing `SourceRange` instead of creating a duplicate range shape.

```ts
export type CallCompatibilityStatus = "likely_mismatch" | "compatible" | "unknown";

export type CallCompatibilityReason =
  | "argument_count_below_minimum"
  | "argument_count_above_maximum"
  | "signature_or_callsite_unknown"
  | "compatible_argument_count";

export interface CallCompatibilityHint {
  status: CallCompatibilityStatus;
  reason: CallCompatibilityReason;
  changedSymbolId: string;
  callsiteFile: string;
  callsiteRange: SourceRange;
  callerSymbolId?: string;
  expected: {
    minArgs: number;
    maxArgs: number | null;
    confidence: "high";
  };
  actual: {
    argCount: number;
    confidence: "high";
  };
}
```

Extend the changed-symbol report interface with:

```ts
callCompatibility?: CallCompatibilityHint[];
```

- [ ] **Step 4: Run the focused test**

Run:

```bash
npx vitest run tests/impact-signature.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/impact/types.ts tests/impact-signature.test.ts
git commit -m "Add call compatibility report types"
```

## Task 2: Extract First-Provider Signature Metadata

**Files:**

- Create: `src/impact/callCompatibility.ts`
- Modify: `src/impact/index.ts`
- Test: `tests/impact-signature.test.ts`

- [ ] **Step 1: Add failing unit tests for first-provider signature parsing**

Add tests for ordinary, optional, defaulted, and rest parameters in the first JS/TS-family provider. These tests prove the provider contract, not the full merge bar.

```ts
import { extractCallableSignature } from "../src/impact/callCompatibility.js";

it("extracts fixed arity for simple TypeScript functions", () => {
  const source = "export function helper(a: string, b: number) { return a + b; }";
  const signature = extractCallableSignature({
    languageId: "typescript",
    source,
    symbolStartIndex: source.indexOf("helper"),
  });

  expect(signature).toEqual({ minArgs: 2, maxArgs: 2, confidence: "high" });
});

it("extracts minimum arity for optional and defaulted parameters", () => {
  const source = "export function helper(a: string, b = 1, c?: boolean) { return a; }";
  const signature = extractCallableSignature({
    languageId: "typescript",
    source,
    symbolStartIndex: source.indexOf("helper"),
  });

  expect(signature).toEqual({ minArgs: 1, maxArgs: 3, confidence: "high" });
});

it("marks rest signatures as unbounded", () => {
  const source = "export function helper(a: string, ...rest: string[]) { return rest; }";
  const signature = extractCallableSignature({
    languageId: "typescript",
    source,
    symbolStartIndex: source.indexOf("helper"),
  });

  expect(signature).toEqual({ minArgs: 1, maxArgs: null, confidence: "high" });
});

it("returns null for unsupported languages", () => {
  const source = "def helper(a, b):\n    return a";
  const signature = extractCallableSignature({
    languageId: "python",
    source,
    symbolStartIndex: source.indexOf("helper"),
  });

  expect(signature).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npx vitest run tests/impact-signature.test.ts
```

Expected: FAIL because `src/impact/callCompatibility.ts` does not exist.

- [ ] **Step 3: Implement the minimal extractor**

Create `src/impact/callCompatibility.ts`.

Implementation guidance:

- Support `javascript`, `typescript`, `tsx`, and `jsx` language IDs in the first provider.
- Keep the provider behind the registry when the provider architecture task is in place.
- Do not document or ship this as a public language-complete feature until the cross-language matrix is complete.
- Find the nearest parameter list after `symbolStartIndex`.
- Count top-level comma-separated parameters.
- Treat `?` and `=` at top level as optional/defaulted.
- Treat a parameter starting with `...` as rest.
- Return `null` when parentheses cannot be found or balanced.
- Use helper functions for top-level scanning; do not use nested ternaries.

Export:

```ts
export interface CallableSignature {
  minArgs: number;
  maxArgs: number | null;
  confidence: "high";
}

export interface ExtractCallableSignatureRequest {
  languageId: string;
  source: string;
  symbolStartIndex: number;
}

export function extractCallableSignature(request: ExtractCallableSignatureRequest): CallableSignature | null;
```

- [ ] **Step 4: Re-export from impact index**

In `src/impact/index.ts`, export the new helper only if this file already exports public impact helpers. If it is internal-only today, skip the export and import it directly in tests from the file.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx vitest run tests/impact-signature.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/impact/callCompatibility.ts src/impact/index.ts tests/impact-signature.test.ts
git commit -m "Extract conservative callable signatures"
```

## Task 3: Extract High-Confidence Callsite Argument Counts

**Files:**

- Modify: `src/impact/callCompatibility.ts`
- Test: `tests/impact-signature.test.ts`

- [ ] **Step 1: Add failing first-provider callsite tests**

```ts
import { extractCallsiteArguments } from "../src/impact/callCompatibility.js";

it("counts fixed callsite arguments", () => {
  const source = "helper(one, two, three);";
  const call = extractCallsiteArguments({
    languageId: "typescript",
    source,
    calleeStartIndex: source.indexOf("helper"),
  });

  expect(call).toEqual({ argCount: 3, confidence: "high" });
});

it("counts nested expressions as one argument each", () => {
  const source = "helper(fn(a, b), { x: [1, 2] });";
  const call = extractCallsiteArguments({
    languageId: "typescript",
    source,
    calleeStartIndex: source.indexOf("helper"),
  });

  expect(call).toEqual({ argCount: 2, confidence: "high" });
});

it("returns null for spread arguments", () => {
  const source = "helper(...values);";
  const call = extractCallsiteArguments({
    languageId: "typescript",
    source,
    calleeStartIndex: source.indexOf("helper"),
  });

  expect(call).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npx vitest run tests/impact-signature.test.ts
```

Expected: FAIL because `extractCallsiteArguments` is missing.

- [ ] **Step 3: Implement callsite counting**

Add:

```ts
export interface CallsiteArguments {
  argCount: number;
  confidence: "high";
}

export interface ExtractCallsiteArgumentsRequest {
  languageId: string;
  source: string;
  calleeStartIndex: number;
}

export function extractCallsiteArguments(request: ExtractCallsiteArgumentsRequest): CallsiteArguments | null;
```

Implementation rules:

- Support JS/TS-family language IDs in the first provider.
- Return `null` for every language without a provider.
- Do not ship public call compatibility output until the provider matrix is complete.
- Find the first balanced `(` after the callee start.
- Count top-level comma groups.
- Return zero for an empty argument list.
- Return `null` if any top-level argument starts with `...`.
- Return `null` for unbalanced calls.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx vitest run tests/impact-signature.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/impact/callCompatibility.ts tests/impact-signature.test.ts
git commit -m "Extract conservative callsite arity"
```

## Task 4: Attach Compatibility Hints to Impact Reports

**Files:**

- Modify: `src/impact/analyzer.ts`
- Modify: `src/impact/types.ts`
- Modify: `src/impact/map.ts` if changed-symbol mapping needs source text or symbol range access.
- Test: `tests/impact-analyzer.test.ts`

- [ ] **Step 1: Add failing impact integration test**

Create a temp repo fixture where `helper(a)` becomes `helper(a, b)` and `main.ts` still calls `helper("x")`.

Expected assertion shape:

```ts
const helper = report.changedSymbols.find((symbol) => symbol.name === "helper");
expect(helper?.callCompatibility).toContainEqual(
  expect.objectContaining({
    status: "likely_mismatch",
    reason: "argument_count_below_minimum",
    actual: { argCount: 1, confidence: "high" },
    expected: { minArgs: 2, maxArgs: 2, confidence: "high" },
    callsiteFile: "src/main.ts",
  }),
);
```

Also add a rest-argument case where `helper(a, ...rest)` does not emit a mismatch for extra arguments.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npx vitest run tests/impact-analyzer.test.ts
```

Expected: FAIL because compatibility hints are not attached.

- [ ] **Step 3: Implement compatibility collection**

In `src/impact/analyzer.ts`, after changed symbols are known and before final sorting:

- For each changed callable symbol with `signatureChanged`, read its source file.
- Extract the new signature from the head/current source.
- Use existing reference/callsite data when available. Prefer existing review callsite helpers if `src/review.ts` exposes a reusable function; otherwise add a focused internal helper in `src/impact/callCompatibility.ts`.
- Only inspect callsites that resolve to the changed symbol through existing graph/reference data.
- Attach hints to the matching changed-symbol report object.

Do not scan every matching text occurrence. The feature must be resolution-backed.

- [ ] **Step 4: Run focused impact tests**

Run:

```bash
npx vitest run tests/impact-analyzer.test.ts tests/impact-signature.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/impact/analyzer.ts src/impact/map.ts src/impact/types.ts src/impact/callCompatibility.ts tests/impact-analyzer.test.ts tests/impact-signature.test.ts
git commit -m "Attach call compatibility hints to impact"
```

## Task 5: Surface Hints in Review and CLI Output

**Files:**

- Modify: `src/review.ts`
- Modify: `src/impact/reportFull.ts`
- Modify: `src/impact/reportCompact.ts`
- Modify: `src/impact/report.ts`
- Modify: `src/cli/impact.ts`
- Modify: `src/cli/review.ts`
- Test: `tests/review.test.ts`
- Test: `tests/impact-cli.test.ts`

- [ ] **Step 1: Add failing review and CLI assertions**

In `tests/review.test.ts`, assert that `buildReviewReport()` carries compatibility hints for the same fixture as Task 4.

In `tests/impact-cli.test.ts`, assert:

- JSON includes `callCompatibility`.
- Pretty output includes `Call compatibility` only when there is a likely mismatch.
- Pretty output does not print `unknown` hints as findings.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npx vitest run tests/review.test.ts tests/impact-cli.test.ts
```

Expected: FAIL because output does not include the new section.

- [ ] **Step 3: Implement presentation**

Rendering rule:

```text
Call compatibility:
- helper: src/main.ts:3 passes 1 argument; new signature requires 2.
```

Keep the section short. Do not render compatible or unknown hints in pretty output unless JSON is requested.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx vitest run tests/review.test.ts tests/impact-cli.test.ts tests/impact-analyzer.test.ts tests/impact-signature.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review.ts src/impact/reportFull.ts src/impact/reportCompact.ts src/impact/report.ts src/cli/impact.ts src/cli/review.ts tests/review.test.ts tests/impact-cli.test.ts
git commit -m "Render call compatibility findings"
```

## Task 6: Document Honest Capability Boundaries

**Files:**

- Modify: `README.md`
- Modify: `docs/cli.md`
- Modify: `docs/library-api.md`
- Modify: `docs/agent-workflows.md`
- Modify: `docs/language-parity.md`
- Modify: `docs/scenario-catalog.md`
- Modify: `codegraph-skill/codegraph/SKILL.md`
- Test: `tests/package-metadata.test.ts`

- [ ] **Step 1: Update docs**

Docs must state:

- Compatibility hints are conservative review/impact hints, not type checking.
- Public likely-mismatch support depends on the provider matrix in `docs/language-parity.md`.
- Any language without high-confidence provider coverage is explicitly marked unsupported or not applicable.
- Unsupported or ambiguous callsites are omitted from pretty output and represented as `unknown` only in structured data when useful.
- Agents should treat hints as review leads and still inspect the code.

- [ ] **Step 2: Update skill guidance**

In `codegraph-skill/codegraph/SKILL.md`, add a short note under PR impact/review:

```md
Impact and review JSON may include `callCompatibility` for high-confidence provider-backed callsite arity mismatches after signature changes. Treat it as a deterministic review lead, not compiler-grade type checking, and check the language parity matrix before assuming coverage.
```

- [ ] **Step 3: Run metadata and formatting checks**

Run:

```bash
npx vitest run tests/package-metadata.test.ts
git diff --check
```

Expected: PASS and no whitespace errors.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/cli.md docs/library-api.md docs/agent-workflows.md docs/language-parity.md docs/scenario-catalog.md codegraph-skill/codegraph/SKILL.md tests/package-metadata.test.ts
git commit -m "Document call compatibility boundaries"
```

## Follow-On: Conservative Repair Hints

Call compatibility is the first deterministic "this likely broke" signal. Future repair hints should follow the same rule: emit only when Codegraph has high-confidence structural evidence, and phrase every result as a review lead.

Candidate hint families:

- missing import, export, and declaration hints already produced by impact suggestions
- JS/TS method call compatibility after receiver-aware method references are implemented
- public API removal hints from architecture drift
- duplicate-touched-code hints from duplicate groups in review or explain packets

Rules:

- Do not generate patches in this layer.
- Do not claim type safety or semantic equivalence.
- Keep pretty output limited to likely actionable findings.
- Preserve complete structured evidence in JSON for agents.

## Final Verification

- [x] Run:

```bash
npm run lint
npm run build
npm run test:ci
git diff --check
```

- [x] Expected:

```text
lint passes
build passes
test:ci passes
git diff --check prints no errors
```

- [x] If focused Windows native artifact copying fails with `EPERM` during targeted tests, rerun the full suite after `npm run build` and document the focused failure separately.

## Completion Notes

- Implemented provider-backed call compatibility support for source languages with callable syntax:
  - TypeScript, TSX, JavaScript, JSX
  - Python, Go, Rust, Java, C#, Kotlin, Swift, PHP, Ruby, C, C++, Zig
- Kept graph-only and non-call-model languages out of the support matrix:
  - HTML, Astro, Handlebars, CSS, SCSS, Less, Markdown, MDX, reStructuredText, AsciiDoc, Vue, Svelte, SQL
- Added AST-first extraction:
  - Signature extraction locates declaration parameter ranges through Tree-sitter/native AST.
  - Callsite extraction locates call argument ranges through Tree-sitter/native AST.
  - Text splitting is limited to AST-identified parameter or argument ranges.
- Preserved conservative behavior:
  - Spread/splat callsites return unknown instead of forcing a count.
  - Unsupported source files are skipped before parsing.
  - Pretty output still shows only likely mismatches.
- Added resolution-backed callsite verification:
  - Uses existing references where available.
  - Falls back to AST call scanning only when `goToDefinition()` verifies the call target resolves to the changed symbol.
- Updated docs:
  - `README.md`
  - `docs/cli.md`
  - `docs/library-api.md`
  - `docs/agent-workflows.md`
  - `docs/language-parity.md`
  - `docs/scenario-catalog.md`
  - `codegraph-skill/codegraph/SKILL.md`
- Added tests:
  - `tests/impact-call-compatibility/cross-language.test.ts`
  - `tests/impact-call-compatibility/provider-registry.test.ts`
  - Cross-language impact integration coverage in `tests/impact-analyzer.test.ts`
- Verification completed on 2026-05-27:
  - `npm run lint`
  - `npm run build`
  - `npm run test:ci`
  - `git diff --check`
