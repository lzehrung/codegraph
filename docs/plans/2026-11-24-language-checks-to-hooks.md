# Language identity checks to language data

Baseline: `473d5de7`. This is a behavior-preserving cutover, not an accuracy change. Run `node scripts/language-check-inventory.mjs` for the reproducible file:line:column inventory, including the enclosing condition and branch excerpt, language IDs, category, destination, exemption reason, and file owner. Use `--summary` for current counts. A decision with multiple comparisons has multiple entries; a branch's full condition, not one subcomparison alone, controls its action.

## Inventory and boundaries

The inventory has 940 records in 91 source files: 828 identity comparisons, 33 direct or named membership checks, and 79 calls to already-centralized family helpers. Of these, 787 records across 660 distinct file:line pairs should move; 153 records are exempt. The approximately 636-site starting estimate was line-oriented; this inventory also includes reversed/optional comparisons, target/use-language variables, membership checks, graph/document formats, and helper calls. A record is an AST expression, not an assertion that the same line has only one decision.

The scan covers `src/**/*.ts`, compares actual registered IDs against language operands (including `sup.id`, `support?.id`, `languageId`, `targetLanguage`, and `useLanguage`), plus literal and audited named language-set memberships. It explicitly includes the three centralized ECMAScript/JVM/graph-only helpers and dynamic native/provider membership tests as exemptions. Switch/case language-ID sites were searched; none exist at this baseline. Import-mechanism values, project-file-type enums, symbol/node IDs, and arbitrary text equal to a language name are not language-support checks and are outside the move count. Keep the source excerpt when interpreting a decision: absent support, negative comparisons, type/value namespace, import form, and cross-language source/target identity can change the result.

## Existing architecture and cutover rules

- `LanguageDefinition` is declared in `src/languages/types.ts`; the actual `LanguageSupport` is declared in `src/languages.ts`, and `adaptDefinition` supplies its defaults. Add immutable data to both when a runtime consumer needs it; adapt once, do not repeatedly construct data. Preserve definition composition for TS/TSX and SFCs.
- `ScopeNodeRow` in `src/indexer/scope-nodes.ts` already holds grammar node sets, namespace/visibility decisions, and `referenceNeedsVerification`. Extend it only for the remaining scope decisions. Do not replace the scope walker or change the owned `ScopeIndex` passed to graph passes.
- `NameLookupPolicy` stages in `name-resolution-types.ts` already cover `beforeLexical`, `ignoresBinding`, `onLocal`, `beforeCrossModule`, `afterCrossModule`, `moduleAliasIsUnshadowed`, and `preloadFiles`. Use those stages first; preserve their exact order and `undefined`-means-continue contract.
- `MemberLookupPolicy` already has `useOf`, `memberWalk`, `memberAccessRules`, `callEdge`, `memberNameKey`, `implicitMember`, `qualifiedConstruction`, `unprovenReference`, and `parameterReferenceScanFilter`. Reuse them where the per-site inventory names them. Preserve `MemberWalkRules` hierarchy, visibility, scope, arity, and short-circuit ordering.
- `MemberAccessRow` in `src/util/member-access-tables.ts`, `ImportResolutionRow` in `src/indexer/import-resolution-tables.ts`, and the existing callable-arity profiles already encode per-language syntax/capability data. Do not add a second set or infer a language from a node shape.
- Move the language-specific operation itself into a language-owned definition, row, or policy fragment. A field named `isPhp`/`isSwift`, a new switch on a language-shaped enum, or a pile of identical singleton-language flags merely hides the old branch and is not this cutover. Prefer one domain capability or one policy operation with its existing default; keep the shared algorithm responsible for common sequencing.
- When resolving a use in one language against a target in another, select the policy for the side that the existing comparison actually inspected. Preserve optional-support behavior, file-extension remapping, normalization, aliases, root confinement, provenance, reference coverage, and the distinction between an authoritative miss and continuation.

## Categories and per-site destinations

This summary is grouped by the semantic decision, not by the language name. The inventory script produces the complete site-level table and distinguishes multiple decisions within a single function.

- `bare-binding` (16): `NameLookupPolicy.bindingResolution` and existing lookup stages.
- `bare-name` (19): `NameLookupPolicy.beforeLexical`, `beforeCrossModule`, `onLocal`, and `afterCrossModule`.
- `callable-identity` (23): `CallableIdentityPolicy.forDeclaration` and callable-arity profiles.
- `callable-impact` (10): callable identity and `MemberLookupPolicy.receiverResolution`.
- `declaration-extraction` (40): `IndexLanguagePolicy.declarations`.
- `declaration-visibility` (5): `MemberLookupPolicy.ownerResolution` and `MemberWalkRules.memberVisible`.
- `docstring-capture` (2): `LanguageDefinition.capturesDocstrings`.
- `graph-consumer` (18): `MemberLookupPolicy.graph`, `callEdge`, and the shared name policy.
- `identifier-validation` (5): `LanguageDefinition.identifierValidation`.
- `impact-syntax` (11): `LanguageDefinition.impactDefinitionTypes`.
- `import-extraction` (55): `SpecifierExtractionPolicy.collect`.
- `import-name-lookup` (105): `NameLookupPolicy.imports`, existing lookup stages, and import-resolution rows.
- `incremental-surface` (19): `IndexLanguagePolicy.publicSurface` and existing external-specifier rows.
- `index-build` (45): `IndexLanguagePolicy.module` and the existing ECMAScript family helper.
- `member-owner` (74): `MemberLookupPolicy.ownerResolution`, `memberWalk`, and graph owner facts.
- `member-selection` (6): `MemberLookupPolicy.memberNameKey`, `memberWalk`, and `separateMemberScopes`.
- `member-syntax` (16): `MemberAccessRow.qualifiedAccess`.
- `member-use` (11): `MemberLookupPolicy.useOf`.
- `positioned-name-lookup` (19): existing `NameLookupPolicy.beforeLexical` and receiver policy.
- `receiver-resolution` (102): `MemberLookupPolicy.receiverResolution`, `memberAccessRules`, and `callEdge`.
- `receiver-syntax` (16): `MemberAccessRow.qualifiedAccess` and receiver policy.
- `reference-context` (5): `LanguageDefinition.referenceBlockPriorities`.
- `reference-planning` (80): `NameLookupPolicy.references` and existing member reference hooks.
- `reference-prefilter` (2): `LanguageDefinition.bloomAlternateKey` and `bloomSourceTokens`.
- `scope-binding` (30): `ScopeNodeRow.bindingRules`.
- `scope-type-position` (3): `ScopeNodeRow.typeOnlyName` and `typeOnlyParentTypes`.
- `specifier-targets` (38): `SpecifierTargetPolicy.resolve`, `resolveImport`, and `ImportResolutionRow.packageSyntax`.
- `unit-package-facts` (12): `ImportResolutionRow.implicitCompilationUnit` and `packageSyntax`.

For example, `navigation-goto.ts` member-owner decisions move to owner/member-walk policy, its receiver lookup decisions to receiver policy, and its import/name decisions to name/import policy. `edge-passes.ts` calls those same lookup and member operations; its remaining graph-only emission facts go to the graph portion of the member policy. The graph must not grow a competing resolver. Scope lookup, index construction, reference candidate selection, and import targets likewise keep one common decision per domain.

## New fields and hot-path contract

These are the proposed new fields, grouped by domain rather than by language. All are optional where shown. An absent field means the existing generic behavior; never install a function that silently returns a dummy answer. A selected specialized hook returns `undefined` only to continue the existing sequence; use `null` or the existing explicit result union for a final miss where the old branch stopped. Empty arrays and sets stay valid answers, not unavailable markers. Exact context types are extracted from the existing function parameters listed below into leaf type modules; they contain the same already-owned objects, not copies or an untyped context.

- `LanguageDefinition.identifierValidation` / `LanguageSupport.identifierValidation`: `IdentifierValidation`; absent uses the conservative pattern. Read once per rename request.
- `LanguageDefinition.bloomAlternateKey` / `LanguageSupport.bloomAlternateKey`: `(normalized: string) => string`; absent adds no key. Hoist once per file and call only where the old path folded a token.
- `LanguageDefinition.bloomSourceTokens` / `LanguageSupport.bloomSourceTokens`: `(source: string, add: (token: string) => void) => void`; absent adds no markers. Read once per file.
- `LanguageDefinition.capturesDocstrings` / `LanguageSupport.capturesDocstrings`: `boolean`; default false. Read once per module.
- `LanguageDefinition.referenceBlockPriorities` / `LanguageSupport.referenceBlockPriorities`: `Readonly<Record<string, 0 | 1 | 2>>`; default shared empty record and missing-key priority zero. Hoist before ancestor traversal.
- `LanguageDefinition.impactDefinitionTypes` / `LanguageSupport.impactDefinitionTypes`: `ImpactDefinitionShapes`; absent uses generic classification. Read once per changed file and call a predicate only for an already-specialized candidate.
- `ScopeNodeRow.typeOnlyParentTypes`: `ReadonlySet<string>`; absent means empty. Read the row once and use a set lookup.
- `ScopeNodeRow.typeOnlyName`: `(node: SyntaxNodeLike) => boolean`; absent falls back to node/parent type tables. Call only where the old branch already called a specialized predicate.
- `ScopeNodeRow.bindingRules`: `ScopeBindingRules`; absent uses generic binding behavior. Hoist once per scope walk and use data rather than a per-identifier language predicate.
- `MemberAccessRow.qualifiedAccess`: `QualifiedAccessShapes`; absent uses generic access rules. Hoist once per parsed file or operation.
- `MemberLookupPolicy.separateMemberScopes`: `boolean`; absent means false. Read a preselected policy field.
- `MemberLookupPolicy.receiverResolution`: `ReceiverHooks`; absent keeps generic receiver lookup. Read once per member/receiver operation.
- `MemberLookupPolicy.ownerResolution`: `OwnerHooks`; absent keeps generic owner lookup. Read once per owner query.
- `MemberLookupPolicy.graph`: `GraphHooks`; absent adds no graph facts. Read once per module and gate declaration/owner/call events.
- `NameLookupPolicy.bindingResolution`: `BindingHooks`; absent keeps generic binding selection. Cache per query and call a specialized selector only on its old branch.
- `NameLookupPolicy.imports`: `ImportNameHooks`; absent keeps generic import lookup. Cache per file or lookup.
- `NameLookupPolicy.references`: `ReferenceHooks`; absent keeps generic reference planning. Read once per references request.
- `CallableArityLanguageProfile.memberLookupBinding`: `CallableBinding`; absent means `"bound"`. Read the existing profile once per operation.
- `CallableArityLanguageProfile.graphDeclarationParameters`: `GraphParameterShapes`; absent keeps generic parameter counting. Hoist data before declaration traversal.
- `CallableIdentityPolicy.forDeclaration`: `(args: CallableIdentityArgs) => CallableIdentity | undefined`; absent uses generic identity. Select once per module and call only for a specialized declaration.
- `IndexLanguagePolicy.module`: `ModuleIndexHooks`; absent keeps generic preparation/build. Run optional operations at file boundaries.
- `IndexLanguagePolicy.declarations`: `DeclarationHooks`; absent keeps generic extraction. Hoist per file and gate specialized declaration forms.
- `IndexLanguagePolicy.publicSurface`: `PublicSurfaceHooks`; absent keeps generic surface/recheck. Resolve once per file or incremental decision.
- `ImportResolutionRow.packageSyntax`: `PackageSyntax`; absent keeps generic unit behavior. Read the existing row once per file.
- `SpecifierExtractionPolicy.collect`: `SpecifierCollectionHooks`; absent keeps generic native-query collection. Run at the existing file/import phase.
- `SpecifierTargetPolicy.resolve`: `(file: string, specifier: string, metadata: SpecifierTargetMetadata) => Promise<SpecifierTargets | undefined>`; absent or undefined keeps generic target resolution. Select once per file/import.
- `SpecifierTargetPolicy.resolveImport`: `(projectRoot: string, fromFile: string, specifier: string, options: ImportSpecifierOptions) => Promise<FileId | { external: string } | undefined>`; absent or undefined keeps generic import resolution. Select once per import.

### Field type detail and reuse

The following type shapes are part of the prerequisite contract; the named context types are exact, typed views of existing arguments rather than new generic containers.

- `ImpactDefinitionShapes = Readonly<{ wholeChangedNode?: boolean; names: readonly Readonly<{ nodeType: string; parentType?: string; field?: string }>[]; acceptsName?: (node: SyntaxNodeLike, source: string) => boolean }>`. Missing `names` entries reject that special form. The HTML predicate retains the existing `isHtmlIdAttributeValue` check.
- `ScopeBindingRules = Readonly<{ functionRedeclarations?: "latest" | "shared-occurrences" | "overload-group" | "signature-group"; usesTagNamespace?: boolean; qualifiedFunctionNames?: boolean; variablePrefix?: string; implicitReceiverName?: string; specialBinding?: ScopeSpecialBindingHook }>`. `ScopeSpecialBindingHook` is a typed operation over the existing `Binding`, `Scope`, and syntax-node arguments, returning the existing binding decision or `undefined` to continue. Reuse existing row callbacks such as `namespaceHidesBinding`, `acceptLocalCapture`, and `referenceNeedsVerification` instead of adding equivalents. The default redeclaration is the current generic latest-binding path.
- `QualifiedAccessShapes = Readonly<{ containingTypes?: ReadonlySet<string>; parentFields?: Readonly<Record<string, string>>; segmentTypes?: ReadonlySet<string>; unwrapNameTypes?: ReadonlySet<string>; quotedSegments?: boolean }>`. Preserve parent/child/field ordering and the current language-specific helper calls for cases not representable by node sets. Existing `memberAccessShapes` and `receiverKeywords` remain the primary rows.
- `ReceiverHooks` groups an optional access resolver with the arguments of `resolveMemberAccessDefinition` and an optional receiver resolver with the arguments of `resolveReceiverDefinition`. Their return types are respectively `Promise<GoToResult | null | undefined>` and `Promise<ResolvedReceiverDefinition | null | undefined>`.
- `OwnerHooks` groups optional shared-owner parts, qualified-owner resolution, and base/heritage resolution over the existing member-owner context. Qualified-owner resolution reuses the existing positional arguments and dependencies, returning `SymbolDef | null | undefined` or a promise of that result so synchronous paths need no extra promise or argument object. Shared-owner parts return `Promise<readonly SharedOwnerContainer[] | undefined>`.
- `GraphHooks` groups optional declaration, owner/heritage, and resolved-call operations over the current `EdgePassContext`/`MemberLookupDeps`, each returning `void | Promise<void>`; they append only the existing edges/facts.
- The receiver/member cutover extends the same contracts with finite call/reference syntax, implicit-receiver call shapes, callable-property arity, and terminal miss reasons in `ReceiverHooks`. `OwnerHooks` also stores shared-owner identity/visibility rules, qualified-owner operations with existing helper dependencies, lookup capabilities, parameter type scope, and implicit-base syntax. Qualified owner operations run only at the existing qualified lookup stage; `undefined` continues the generic path and `null` remains a proven miss.
- `QualifiedAccessShapes` additionally records declared-type spelling, constant/literal segment kinds, minimum segment counts, qualified base field pairs, and complex grammar-specific segment readers. `MemberLookupPolicy.selection` supplies the existing member selector options, including case-insensitive callable-name matching; `typeNameKey` remains separate from member-name equality. File/query boundaries select policy and syntax rows once, and `ReceiverSyntaxContext` threads those facts through binding/receiver walks. Invoke selected syntax operations directly rather than through dispatch wrappers, and keep spelling normalization, traversal order, and candidate caches unchanged.
- `BindingHooks` groups the existing `definitionForBinding` argument list into an optional `SymbolDef | null | undefined` selector and semantic redeclaration data. `ImportNameHooks` groups optional alias normalization, positioned alias resolution, and star-import handling using existing `BareNameUse`, `ImportBinding`, and `NameResolution` types; the synchronous and asynchronous stages keep their existing return types. `ReferenceHooks` groups optional equivalent-definition, candidate-file, and coverage operations over existing `SymbolDef`, `ProjectIndex`, `FileId`, and `ReferenceCoverage` types. It cannot downgrade partial coverage or filter a candidate the old shared resolver could accept.
- `GraphParameterShapes = Readonly<{ directParameterChildType?: string; ignoredParameterTypes?: ReadonlySet<string>; defaultValueSiblingTypes?: ReadonlySet<string>; variadicMarkerTypes?: ReadonlySet<string>; soleVoidMeansEmpty?: boolean }>`. Reuse the existing arity profile and `getCallableArity`; preserve graph-specific parameter counting exactly rather than assuming the two counts are interchangeable.
- `ModuleIndexHooks` groups optional per-file preparation and additional-facts operations over `PreparedBuildFile`, `BuildOptions`, `BuildReport`, and the existing build arguments. `DeclarationHooks` groups capture supplements, declaration facts, and export completion over the existing `collectLocalsAndExportsFromSource` parameters and `ModuleIndex`. `PublicSurfaceHooks` groups name normalization, importable-name extraction, and `declarationImportRecheck` over that function's existing `ImportBinding`, `LanguageSupport`, `DeclarationNameChanges`, and `DeclarationImportRecheck` types. The absent operation always retains the old generic path.
- `PackageSyntax = Readonly<{ packageNodeType?: string; packageNameField?: string; importNodeType?: string; normalizeQualifiedName?: (name: string) => string }>`. `SpecifierCollectionHooks` groups `appendSpecifiers` over the existing `collectModuleSpecifiersFromSource` arguments and `ModuleSpecifier[]` sink, and `appendBindings` over the existing import extraction context and `ImportBinding[]` sink; each returns `void | Promise<void>` at its existing phase. Neither callback runs per identifier.

Keep `CallableIdentityPolicy`, `IndexLanguagePolicy`, `SpecifierExtractionPolicy`, and `SpecifierTargetPolicy` as leaf, per-language row/policy registries using the repository's existing registry convention, not one cross-layer service. Their default rows are shared singletons. Break type-only cycles by moving the existing request/result types to a leaf module; inject current helpers as dependencies as `MemberLookupDeps` already does. Do not make `languages/callable-arity.ts` import the indexer, navigation, or graph. Tests for `tests/source-structure.test.ts` must continue to pass.

The graph declaration cutover selects `GraphHooks.declarationShapes` once per module: split-method recovery, extension-property accessors, object-type aliases, and assigned type factories keep their existing syntax guards. `GraphParameterShapes.positionalParameterChildType` restricts counted children where defaults and modifiers are list siblings. `declarationMemberArity` consumes already-selected `GraphParameterShapes`; graph modules select once, and guarded C++ readers reuse their module-selected row throughout ancestor/recursive walks. The shared Kotlin extension receiver reader lives in `src/languages/kotlin-graph.ts`, so graph and navigation policies can reuse it without a dependency cycle.

`ReferenceHooks` additionally carries candidate-name normalization, compilation-unit options, namespace-binding scope, export separators, callable verification/equivalence modes, and member-definition grammar. A specialized `namedNodeVisitor` is selected once per file and owns spelling equivalence; the generic walker still invokes one visitor per matching identifier. `ReferenceModuleTable.globalNameFiles` caches the files admitting the configured namespace-wide reference strategy.

`GraphHooks` additionally carries callable alias grouping, callable-name forms, member visibility, and named-node/base-specifier grammar. Cycle-free leaf selectors return the same singleton rows exposed by the name/member policy registries, and graph contexts retain selected fields before identifier or member traversal. Graph activation has core/language epoch entries; reference-only data is not persisted.

Precompute the support row, name policy, member policy, and other relevant policy pointers once per file or outer query. Do not construct closures, argument objects, sets, arrays, or policy rows inside identifier/parameter walks. Where a new callback would execute on every identifier that previously only compared `id`, instead encode the finite rule as data or select the entire specialized traversal once outside that walk; if neither preserves the old execution shape, the slice is not ready. Do not claim a guaranteed timing improvement from field reads alone: unchanged work counters and paired profiles/timings are required evidence.

Check an optional shape's presence before reading projected node properties. A missing rule must not trigger `node.type`, `node.parent`, or child lookup work that the original language guard skipped.

## Four disjoint file slices

Each existing shared site file has exactly one owner. Counts are expression sites, not implementation effort. The workers develop concurrently from the prerequisite. Merge **C, D, A, B** in that order, checking each integrated slice before the next. The order lands scope/declaration foundations before imports, then member resolution, then the graph/reference consumers.

| Worker | Scope                                                                                | Move sites | Distinct lines | Existing shared files |
| ------ | ------------------------------------------------------------------------------------ | ---------: | -------------: | --------------------: |
| A      | Receiver/member syntax, owner identity, member selection and goto                    |        202 |            174 |                     5 |
| B      | Positioned navigation/references, detailed/basic graph, call impact                  |        244 |            211 |                     8 |
| C      | Scope, name binding, declarations, build/invalidation facts, policy/type integration |        172 |            144 |                    18 |
| D      | Imports/specifiers, compilation units, resolver paths, remaining semantic consumers  |        169 |            131 |                    24 |

**A (202 sites; 174 distinct lines):**

- `src/graphs/symbol-graph-detailed/receiver-calls.ts`
- `src/indexer/member-selection.ts`
- `src/indexer/navigation-goto.ts`
- `src/indexer/shared-owner-identity.ts`
- `src/util/member-access.ts`

**B (244 sites; 211 distinct lines):**

- `src/graphs/symbol-graph-detailed.ts`
- `src/graphs/symbol-graph-detailed/ast.ts`
- `src/graphs/symbol-graph-detailed/edge-passes.ts`
- `src/graphs/symbol-graph-detailed/import-aliases.ts`
- `src/graphs/symbol-graph.ts`
- `src/impact/call-compatibility.ts`
- `src/indexer/navigation-references.ts`
- `src/indexer/navigation.ts`

**C (172 sites; 144 distinct lines):**

- `src/graphs/angularjs.ts`
- `src/indexer/build-index.ts`
- `src/indexer/build-workers.ts`
- `src/indexer/callable-identity.ts`
- `src/indexer/declaration-visibility.ts`
- `src/indexer/locals-and-exports.ts`
- `src/indexer/name-lookup-policies/implicit-self.ts`
- `src/indexer/name-resolution.ts`
- `src/indexer/navigation-local.ts`
- `src/indexer/public-surface.ts`
- `src/indexer/reference-context.ts`
- `src/indexer/reference-query-index.ts`
- `src/indexer/scope-lookup.ts`
- `src/indexer/scope-nodes.ts`
- `src/indexer/scope.ts`
- `src/indexer/symbols.ts`
- `src/util/bloom-filter.ts`
- `src/util/project-file-facts.ts`

**D (169 sites; 131 distinct lines):**

- `src/agent/rename-preview.ts`
- `src/document-links.ts`
- `src/duplicates/units.ts`
- `src/graph-edge-collector.ts`
- `src/graphs/specifiers.ts`
- `src/impact/analyzer.ts`
- `src/impact/map.ts`
- `src/indexer/build-cache/resolver-environment.ts`
- `src/indexer/compilation-units.ts`
- `src/indexer/expand-star-imports.ts`
- `src/indexer/imports.ts`
- `src/indexer/imports/import-binding-tables.ts`
- `src/indexer/imports/js-text-imports.ts`
- `src/indexer/imports/language-specific.ts`
- `src/indexer/imports/native-captures.ts`
- `src/indexer/incremental-plan.ts`
- `src/indexer/navigation-resolve.ts`
- `src/indexer/star-import-precedence.ts`
- `src/languages/callable-arity.ts`
- `src/util/jvm-tree.ts`
- `src/util/resolution.ts`
- `src/util/resolution/jvm.ts`
- `src/util/resolution/specifier-targets.ts`
- `src/util/syntax-tree.ts`

**Prerequisite and merge ownership.** The prerequisite defines the typed optional fields, leaf context types, and adapter defaults without activating them. Each slice worker owns its listed existing shared site files and wires its own language-policy fragments into the definition, registry, and type files required by its own pull request. These shared wiring files are not exclusively owned by one worker.

The fingerprint coverage list acknowledges these dormant fields but does not yet hash their data. Before a slice makes a field affect indexed or persisted facts, add its declarative inputs to the implementation fingerprint and record the applicable core or language epoch. Query-only fields do not require persisted-cache invalidation.

Merge slices **C, D, A, B**. Each later slice rebases after its predecessor merges and resolves the expected additive registry/type conflicts, preserving every earlier field and language row. Verify each rebased slice on its actual integrated base. No slice is complete with unreferenced policy fragments or without its own wiring.

## Exemptions and lint rule

Exemptions are per-site in the inventory, never permission to add a fresh semantic branch in an otherwise shared file:

1. Existing `isJsTsLanguage` (`src/languages/js-family.ts`), `isJvmLanguage` (`src/util/syntax-tree.ts`), graph-only helpers (`src/document-links/language-ids.ts`), the HTML-like helper, and `DECLARATION_RESOLVED_IMPORT_LANGUAGES` derived from `ImportResolutionRow`. These are already-centralized family/capability data. The separate Angular JS set is not exempt: replace it with the existing family helper.
2. `src/bootstrap/tree-sitter-languages.ts` grammar registration; `src/chunking/chunk-sfc.ts`, `src/languages/file-prep.ts`, and `src/languages/sfc.ts` component framework/embedded-tag selection; `src/cli/chunk.ts` CLI chunk dispatch; `src/drift/languages.ts` serialized label mapping; and `src/document-links/check.ts`'s Markdown-only link checker. These are actual format or entry-point identity, not resolution semantics.
3. `src/indexer/build-cache/module-cache.ts` and `src/indexer/build-cache/project-snapshot.ts`: only the persisted `jvmPackageLanguageId` enum validation checks. The remaining resolver-environment and cache behavior is not blanket-exempt.
4. Actual same-language boundaries inside `src/indexer/kotlin-call-compatibility.ts`, `kotlin-callable-index.ts`, `kotlin-lambda-receiver.ts`, `navigation-cpp.ts`, `php-namespace-symbols.ts`, `swift-enum.ts`, `src/util/csharp-project-usings.ts`, `src/util/resolution/{csharp,php,terraform}.ts`, `src/terraform/resolution.ts`, `src/sql/classify-sql-file.ts`, the Swift member-policy modules, and the TypeScript policy in `name-lookup-policies/index.ts`. These specific checks validate the _target file_ before a language-owned routine reads its grammar. Do not turn those files into a blanket exemption for new unrelated language checks.
5. Dynamic native-addon support sets, the CLI/call-compatibility provider registries, and the set of unsupported languages being reported are runtime membership/metadata, not literals selecting a language semantic rule. The inventory records these individually as `runtime-dependent`.

The eight relocated target-file safety checks in `member-lookup-policies/cpp-receiver.ts`,
`member-lookup-policies/csharp-owner.ts`, and `util/resolution/csharp.ts` also qualify under
exemption 4. The inventory lists their exact function/expression pairs, not whole files.
`npm run language-checks:check` ratchets the remaining non-exempt sites using normalized
function/condition/expression fingerprints and occurrence counts in `scripts/language-check-baseline.json`.
After a site moves, run `node scripts/language-check-inventory.mjs --write-baseline` to remove its
stale entry; the command refuses new sites. This interim ratchet does not replace the final
provenance-aware lint rule below.

Implement a small local ESLint rule `scripts/eslint-rules/no-inline-language-checks.mjs`, following the existing local-plugin import pattern in `eslint.config.js`. Apply it to shipped `src/**/*.ts` so the long tail is covered, including `src/indexer/**`, `src/graphs/**`, `src/util/**`, `src/impact/**`, `src/agent/**`, and `src/languages/callable-arity.ts`; exclude generated/fixture paths as the existing config already does. Use the TypeScript parser services and actual symbol/initializer provenance, not a textual ban on every property named `id`. A simple `no-restricted-syntax` selector alone cannot reliably distinguish a syntax-node ID, a persisted enum, or an alias of `sup.id`.

The rule must detect strict/non-strict equality and inequality in either operand order, optional/computed `id`, destructuring and local aliases, `switch` cases, and literal/constant array or set `includes`/`has` membership. Resolve finite constant aliases and statically declared language-ID sets; use the registered language IDs as the asserted list, including document formats, so a newly registered ID cannot escape. Do not flag comparisons of two dynamic IDs solely to test identity, import-mechanism enum checks, syntax-node IDs, a native availability set, or the exact existing exemptions above. Allow family helper calls only by resolved import/definition provenance; a new helper wrapping the same inline check cannot evade the rule. Constrain exemptions by exact file, enclosing function, and boundary purpose, not whole shared directories.

Add RuleTester coverage for positive cases (reversed comparisons, aliases, computed/optional access, negation, switches, array/set constants, and a newly registered ID) and negative cases (non-language IDs, cached wire enum validation, dynamic addon support, existing family helpers, and the listed format/CLI boundaries). Test that a new comparison in each covered shared subtree fails and that an exemption cannot be used from another function. Land the lint rule in its own final pull request after B. Enable it as an error only when the inventory reaches zero non-exempt entries; the final inventory must be empty apart from the documented exemptions.

## Verification contract for every integrated slice

Use a built candidate checkout and the read-only baseline build; never run a build or write a cache in the baseline checkout. Serialize builds, tests, and differentials on the shared machine and cap Vitest workers at 2. Capture each corpus revision/content fingerprint and use identical root, extension/config settings, native runtime, file selection, cache mode, thread count, and query list for base and candidate.

1. Run `npm run answers:snapshot:check` and `npm run graph:snapshot:check`; both must be byte-identical, including ordering, reference coverage/reasons, provenance, ranges, and every file/import/detailed graph edge. Regenerating snapshots is not a way to accept a refactor difference. Also run `npm run bench:fixtures:check` and `npx vitest run tests/call-form-matrix --maxWorkers=2` (all language matrix suites and the report check).
2. Independently load each build and run all parseable identifier/property/shorthand positions through goto, every indexed declaration and distinct goto target through references, and all file and detailed graph edges through a deterministic graph dump. Compare complete normalized result records, including failed/unavailable status, reference ordering, coverage, provenance, and metadata; graph node/edge identity and callsite ranges must agree. Use the existing `scripts/answer-snapshot-lib.mjs` `loadAnswerApi` and `answerProjectRecords` as the answer oracle, with a scratch graph driver equivalent to `scripts/graph-edge-snapshot.mjs` (that graph script only discovers repository fixtures). Run the two builds in separate processes to avoid singleton/native-state cross-contamination. A prior differential script hard-coded to another checkout is not a valid oracle without adapting its paths and completeness rules.
3. Require **zero** goto, references, file-edge, or detailed-edge differences for every corpus below and report counts of files, parsed/unavailable files, positions, reference targets, edges, and mismatches. Assert that each intended language actually has indexed files and nonzero queried positions. A truncated graph, lexical fallback, silently skipped target, mismatched unsupported error, or zero-size sample is a failed gate, not a passing zero. If a corpus cannot be fully processed, record the exact blocker and do not mark the slice complete.
4. Record and compare the actual integer work counters: `BuildReport.files` total/changed/cached/parsed/failed, cache hits/misses, native backend files used/fell back and per-language counts, worker tasks submitted/failed/module records, graph node/edge counts, goto request/answer counts, reference targets/candidates/coverage, and native parse/scope-build counts where exposed by tests. Fix any increment, extra scan, allocation, or changed fallback; do not hide it behind stable answer counts. For cold, memory-warm and disk-warm indexes, also compare answers after a file edit, delete, rename back, and restore in disposable _copies_; keep per-build caches separate.
5. Perform paired interleaved base/head performance runs on a large real project for cold build, no-change update, one-file update, graph build, goto, and references: at least five alternating rounds with equal work. The existing `scripts/benchmarks/paired-benchmark.mjs` checks pinned revisions and accepts a corpus map; use compatible pinned corpora or fail clearly. Investigate a regression with CPU profiles and restore the old execution shape; do not claim that fewer string comparisons alone prove a speedup.
6. Run focused language, scope, import, navigation, reference, graph, native-semantic-parity, source-structure, and cache-invalidation suites for the touched rules, plus the full Vitest suite once after integration. Run the repository's full `npm run check` after all slices. A pure internal zero-answer-difference refactor needs no user-facing changelog fragment; if a hook/fact or persisted indexed behavior changes, follow `AGENTS.md` and add the appropriate unique language/core epoch entry, never rewrite epoch numbers. Any user-visible difference is outside this refactor and blocks the zero-difference gate.

### Real-corpus coverage

Run the differential on real projects from every affected family: Hono (TypeScript), Spectre.Console (C#), Sinatra (Ruby), Flask (Python), Gin (Go), Slim (PHP), Gson (Java), Alamofire (Swift), and ripgrep (Rust). Add Okio for Kotlin, cJSON for C, a real C++ project, and ZLS for Zig. Use real SQL, stylesheet, and document files when their semantic decisions move; verify that each intended language is actually indexed.

Keep corpus inputs read-only and run mutations only in disposable copies. Graph-only documents have no lexical identifier positions; compare their real graph records and explicit unsupported navigation outcomes rather than inventing sites. Record a corpus revision/content fingerprint and fail rather than silently skipping unavailable files.

## Commit-ready checklist

- [ ] Record every language-identity decision by source position, language, behavior, destination policy, and explicit exemption; keep a reproducible inventory tied to the base revision.
- [ ] Define the complete typed policy/data contract and exact generic defaults before parallel edits. Keep the language-support adapter and per-language rows synchronized.
- [ ] Migrate scope, name lookup, member selection, import resolution, declaration/indexing, reference planning, graph, and impact consumers file by file without changing lookup order, coverage, or output.
- [ ] Keep each existing shared site file under one owner; each slice wires its own language-policy fragments and resolves additive registry/type conflicts when rebasing.
- [ ] Keep per-identifier hot paths allocation-free and avoid new per-identifier callbacks. Reuse the already-owned scope index and preserve cold/warm behavior.
- [ ] Require byte-identical `npm run answers:snapshot:check` and `npm run graph:snapshot:check`, plus `npm run bench:fixtures:check` and the complete call-form matrix for every integrated slice.
- [ ] Differentially compare complete goto, references, file edges, and detailed graph edges against the base on real projects from every affected language family; require zero differences and unchanged work counters.
- [ ] Exercise native parity, source-structure, cache invalidation, and focused consumer suites; run the full integration gate after all slices.
- [ ] Record paired interleaved performance results and profiles for build, incremental updates, graph, goto, and references; block a repeatable regression.
- [x] Add a CI baseline ratchet rejecting new non-exempt sites and stale entries while the remaining sites move.
- [ ] After the remaining non-exempt sites move and the inventory reaches zero, add and enable the provenance-aware local ESLint rule in a final pull request. Keep registry, bootstrap, format-specific, and exact language-policy boundary exemptions explicit and narrow.
- [ ] Add core/language cache epoch entries only when the corresponding indexed or hook behavior requires invalidation; do not renumber existing epochs. Omit a changelog fragment only for a behavior-preserving internal refactor.
