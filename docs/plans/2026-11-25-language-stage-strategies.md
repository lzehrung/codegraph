# Language stage strategies

Baseline: `81e2a0a2`. This is a behavior-preserving internal cutover of the remaining 240 inventory records, not an accuracy change. `node scripts/language-check-inventory.mjs --summary` reports 232 non-exempt records (63 A, 159 B, and 10 C); the other eight are the exact target-grammar exemptions described under G6. Together they occupy 222 distinct file:line pairs. The appendix gives every baseline record, including columns where a line contains multiple comparisons.

Earlier slices retained 11 `navigation-local.ts` checks and one PHP partition check. At this baseline the C# generic-arity operation is already selected from the scope row, and the PHP partition has already moved to `reference-query-index.ts`; neither is an additional retained record. Earlier retained-site line numbers have moved, so the appendix uses this baseline's inventory, not the earlier positions.

## Design constraints

A stage is an existing traversal, existing visitor, or an ordered group of operations between existing awaits, not a callback for each branch. Select a language-owned stage once when the relevant query, parsed file, module, or target context becomes authoritative. The generic implementation is the current path with all specialized behavior absent; use immutable singleton rows and existing policy registries or leaf selectors rather than a new central service.

Keep shared lookup sequencing, shared `resolveBareName`, `selectMember`, `resolveExport`, and the locally owned `ScopeIndex`; do not create a second resolver. A stage may call a shared coarse operation once, and its language-specific implementations may share a contiguous generic sub-traversal, but no implementation may wrap the generic visitor in a new per-identifier dispatcher. Finite syntax and domain capability data belong in an existing row where doing so preserves the original guard and avoids projected-node reads for unrelated languages.

Select from the side the original comparison examined. In particular, a use file's language cannot stand in for a dynamically loaded declaration, parsed peer, import target, or reference candidate's language. `supportForFileWithoutHeaderSample` is not authoritative for parsing an unmapped `.h` file: use the already-loaded `ParsedFileContext.sup`, preserve configured extensions and embedded-language selection, and do not introduce a second sample or parse.

The exact baseline callable types below are written as `typeof` the existing declaration, not an approximate replacement signature. Move a currently private declaration and any types named by its signature to a type-only leaf, or use an explicit signature identical to that declaration; do not import a consumer module at runtime just to obtain a type. Nested closure types are expanded below. Add an injected, immutable dependency bundle only where required to break a runtime cycle; it carries references to existing operations, not a new per-use context object.

### Stage inventory

The language column names languages represented by the baseline comparisons, not the only languages that may use the generic implementation. Several groups contain multiple coarse stage functions because their current await and ordering boundaries differ.

| Group | Stage                                      | Records | Languages represented                                                   |
| ----- | ------------------------------------------ | ------: | ----------------------------------------------------------------------- |
| G1    | Local name/import arbitration              |      10 | C, C++, C#, Kotlin, Python                                              |
| G2    | Positioned navigation                      |      11 | C, C++, Kotlin, PHP, Ruby, Swift                                        |
| G3    | Member-access traversal                    |      33 | C++, C#, Go, Java, Kotlin, PHP, Python, Ruby, Rust, Swift, Zig          |
| G4    | Heritage and keyword hierarchy             |      15 | C++, C#, Kotlin, PHP, Python, Ruby, Swift                               |
| G5    | Receiver and target-member proof           |       9 | C++, C#, Go, Kotlin, PHP, Ruby, Rust, Swift                             |
| G6    | Owned helpers and target-grammar safety    |      14 | C++, C#, Go, Python, Ruby, Swift                                        |
| G7    | Graph module, namespace, name and receiver |      23 | C, C++, C#, Go, Kotlin, PHP, Python, Zig                                |
| G8    | Graph owner, body and heritage visitors    |      53 | C++, C#, Go, Java, Kotlin, PHP, Python, Ruby, Rust, Swift, TS, TSX, Zig |
| G9    | Completed-graph traversal                  |      11 | Kotlin, Swift, TS, TSX                                                  |
| G10   | Graph import-target arbitration            |       6 | C, C++, Java, Kotlin, Rust                                              |
| G11   | Impact call binding                        |       3 | C#, Python, Rust                                                        |
| G12   | Reference importer reachability            |      17 | C, C++, C#, Java, Kotlin, Python                                        |
| G13   | Reference occurrence and grammar boundary  |      11 | C, Kotlin, PHP                                                          |
| G14   | Reference request and collection           |      24 | C, C#, Java, Kotlin, PHP, Python, Ruby, SCSS                            |
|       | Total                                      |     240 |                                                                         |

## Stage contracts

`typeof` contracts below refer to the baseline functions with the names shown. A function-valued optional property is absent when its old branch did not run; selecting a stage must not manufacture an async no-op. `undefined` means continue only where the existing called operation already defines that meaning. At a complete traversal boundary, its documented return is final: in particular `null` is not changed to `undefined`, an empty collection is an actual result, and a `GoToResult` with `status: "not_found"` is an authoritative result.

### G1: named lookup and import arbitration

```ts
type NamedImportStage = (
  index: ProjectIndex,
  mod: ModuleIndex,
  file: FileId,
  support: LanguageSupport,
  name: string,
  cNamespace?: "tag" | "ordinary",
  referenceIndex?: number,
  callSite?: { node: SyntaxNodeLike; source: string; typeOnly?: boolean },
  scopeIndex?: ScopeIndex,
) => GoToResult | null;
```

This is the existing `resolveNamedDefinition` signature. Select the complete resolver once from the use support at an enclosing query/file boundary, pass the selected function through existing query state, and call it directly wherever the old resolver was called. The default owns the existing ordinary local-export, explicit-import, compilation-unit and star traversal; C, C++, C#, Kotlin and Python provide specialized complete traversals where their interleaved behavior requires them.

Preserve Kotlin callable-reference and type-position classification, the existing scope-row generic-arity operation, C# selected imports and position, C tag/ordinary rules, C++ unqualified suppression, and Python source-order and dotted-package arbitration. In particular, retain own-import export vetoes, last-wins behavior, provenance, ambiguity, namespace lookup and the exact final `null`. Keep the import and occurrence loops in the selected traversal, not a callback around each import or identifier.

### G2: positioned goto

```ts
type PositionedQueryStage = typeof goToDefinitionInternal;
type UnresolvedMemberStage = typeof isUnresolvedReceiverMemberProperty;
type RubySuperStage = typeof resolveRubySuperDefinition;
```

`goToDefinitionInternal` has `(index: ProjectIndex, req: GoToRequest, parsedContext?: ParsedFileContext, propagateProjectionLimit?: boolean) => Promise<GoToResult>`; `isUnresolvedReceiverMemberProperty` has `(sup: LanguageSupport, node: SyntaxNodeLike) => boolean`. Select the relevant synchronous traversal or existing async function pointer after the query's parsed support is known; select the unresolved-member shape before its parent walk. PHP, Ruby, C++, Kotlin, C and Swift provide the specialized operations, and the generic stage performs the current ordinary positioned/member/bare-name path.

Keep SQL, Terraform and SCSS prechecks, projection-error handling, PHP namespace preparation, Ruby `super`, PHP qualified forms, C++ outer-chain and qualified fallback, Kotlin receiver lookup, and unresolved-member suppression in their original order. PHP normalization and qualified import resolution are one ordered stage even though its existing resolver is awaited. Keep those existing awaits in the original async owner and use direct function pointers for already-async helpers; do not add an async stage wrapper after parsing. `null` from member resolution continues, whereas a returned `not_found` result stops.

### G3: member-access resolution

```ts
type AccessStage = (
  params: ReceiverAccessContext & { memberNamePattern?: RegExp | null },
) => Promise<GoToResult | null>;
type ExpressionStage = (expr: SyntaxNodeLike) => Promise<ResolvedExport | null>;
```

These match `resolveMemberAccessDefinition` and its existing recursive `resolveExpression` closure. Select a complete access traversal from the use support once before access resolution; its selected expression traversal owns its recursion and the existing scope, alias, parsed-file and Python receiver caches. Ruby, Java, C#, Kotlin, Python, PHP, Zig, Rust, Go, Swift and C++ supply the represented specializations; the generic path uses the same lexical/import/receiver/member skeleton without a specialized branch.

Do not move Ruby's constant prelude past the parent check, Java's qualified-type terminal miss past member extraction, or C#'s qualifier and static-import preparation past lexical binding. Preserve positioned imports, direct and deferred targets, Python receiver proof, keyword reports, PHP composed-property and C++ declarator fallback, member acceptance, and recursive chain ordering. The access result's `null` continues the caller's bare-name path; an explicit `not_found` is terminal. `ExpressionStage` returns `null` for an unresolved expression, not a new continuation marker.

### G4: base and keyword walks

```ts
type DeclaredBaseStage = typeof collectDeclaredBaseTypes;
type QualifiedOwnerStage = typeof resolveQualifiedMemberContainer;
type BaseWalkStage = typeof baseRefsFromContainer;
type KeywordWalkStage = typeof resolveKeywordReceiverMember;
```

These retain the exact existing `DeclaredBaseType[]`, `Promise<SymbolDef | undefined>`, `Promise<KeywordClassRef[]>`, and `Promise<SymbolDef | undefined>` results respectively. `KeywordClassRef` is structurally the existing `MemberOwnerRef`; `DeclaredBaseType` and `KeywordMemberReport` move unchanged to a leaf type module. Select the base collector from the declaring parsed file, the qualified/base walker before its existing async entry, and the keyword walk from the already-loaded current owner; inspect a newly loaded base's own support when the old code did.

The default collects and resolves normal declared bases, preserving first occurrence and breadth/depth order. PHP, C++, Ruby, Swift, Python, C# and Kotlin specialize syntax, resolution, trait composition, partial-owner selection or callable compatibility. Keep unproven bases, import-before-local proof, hierarchy depth, abstract-trait and trailing-lambda maps, interface filtering, member selection, report mutation and ambiguity unchanged. The existing `OwnerHooks.qualified` stage still runs first: its `undefined` continues and its `null` is an authoritative miss; Swift's complete fallback follows it without another async forwarding function.

### G5: receiver and target-member proof

```ts
type ReceiverDefinitionStage = typeof resolveReceiverDefinition;
type TargetMemberStage = typeof findReceiverMemberDefinition;
```

`resolveReceiverDefinition` takes the existing positional `ProjectIndex`, object node, source, `LanguageSupport`, `ReceiverSyntaxContext`, expression resolver, module, scope getter, optional `ReceiverBinding`, optional `ResolvedExport`, optional hidden-type resolver, and optional tree; it returns `Promise<ResolvedReceiverDefinition | null>`. `findReceiverMemberDefinition` takes the existing index, locals, member, receiver definition, container, parsed target, normalizer, optional `ReceiverMemberScope`, optional arity and optional class-level flag; it returns `Promise<SymbolDef | undefined>`.

Select the first from the use support before the receiver proof chain; select the second from `targetContext.sup` after the target is loaded, not from the caller. C#, C++, PHP, Go, Ruby and Swift specialize receiver construction/proof; Rust, Go and Kotlin specialize target-member traversal. The default performs the current constructor, declared, imported, direct and member-selection paths. Keep a supplied `resolvedDirect` of `null` distinct from `undefined`, reuse the already-computed proof, retain the original hidden-type and recursive awaits, and do not re-resolve a target merely to select a strategy.

### G6: owned helpers and foreign-grammar boundaries

```ts
type RubyConstantStage = typeof resolveRubyVisibleConstant;
type RubySuperStage = typeof resolveRubySuperDefinition;
type SwiftNestedStage = typeof swiftNestedType;
type SwiftAliasStage = typeof followSwiftAlias;
type GoPeerStage = typeof selectGoReceiverMember;
type PythonClassStage = typeof pythonClassRefFromDef;
type CsharpTargetStage = NonNullable<SpecifierTargetPolicy["acceptsFile"]>;
```

Move each complete Ruby, Swift, Go or Python helper, its helper-specific cache, and required pure syntax readers into its language-owned module. Select use-language Ruby operations before calling them and remove an identity guard only when every caller is proven to select that operation for Ruby. The default is the old absent-operation path; it does not parse a foreign grammar. Swift aliases and nested owners, Go peer files and Python class files must still test the actual loaded target's support before reading grammar-specific nodes.

The ratchet already exempts eight exact target-grammar boundaries. Seven are inside C++/C# owned helpers: preserve the three C++ checks in `cppOutOfLineOwnerPath`, `cppOutOfLineMemberName`, and `cppOutOfLineMemberDeclarationNode`, and the four C# checks in `parsedContextForIdentity`, `csharpPartialExportIdentity`, and `parseCsharpOwnerFile`. The eighth is the C# `acceptsFile` predicate in the mixed namespace-specifier module: move the complete predicate into `util/resolution/csharp.ts`, retain the identical target-file check, and move its exemption to that exact owned function. Do not widen an exemption to a file or remove a safety check just to change the count.

Slice 2 implements G3-G6 as rows of the existing member policies, read where the old code compared the language:

- `resolveMemberAccessDefinition` reads `receiverResolution.access` from the use policy it already selects, and `resolveReceiverDefinition` reads `receiverResolution.construction` from the receiver syntax context.
- The base and keyword walks read `ownerResolution.heritage`, `basesFromParts`, `scopedBaseNames`, `composedOwnerType`, `aliasesReachDeclarations` and `nestedTypePaths` from the declaring or current owner's policy, and reuse the graph rows' `ignoredBaseSpecifierTypes` and `abstractMemberOwnerType`.
- `findReceiverMemberDefinition` calls the target policy's `ownerResolution.receiverMembers`; the Rust, Go and Kotlin traversals live in `member-lookup-policies/`.
- Python class bodies, Swift alias chains and nested types, and Go package files moved to language-owned modules with four exact target-grammar exemptions.
- `resolveRubyVisibleConstant` kept its guard, because the detailed graph's `resolveNamedType` called it for constructed receivers of every language; slice 3 selects it per module and removes the guard.

### G7: graph module and namespace resolution

```ts
type GraphNamespaceStage = (alias: string, useNode: SyntaxNodeLike) => string | undefined;
type GraphNameUseStage = (name: string, node: SyntaxNodeLike) => BareNameUse;
type GraphAliasStage = (name: string, node: SyntaxNodeLike, positionedResolution?: NameResolution | null) => boolean;
type GraphReceiverStage = (node: SyntaxNodeLike) => Promise<SymbolDef | null>;
type GraphModulePreparation = typeof csharpAliasUsesHiddenByMembers;
```

The first four signatures are the existing closures in `buildSymbolGraphDetailed`; their selected functions replace those closures, rather than wrapping them. Select once per parsed module, reuse `EdgePassContext`, the owned scope, alias maps, preloaded parsed provider, implicit-receiver cache, and Python receiver cache. C, C++, Go, Python, Zig, C#, Kotlin and PHP implement the represented namespace, alias, proof or preparation behavior; the generic stage retains the current export and lexical path.

Graph-wide PHP namespace preparation stays in its original pre-graph scan and keeps its one existing await; a selected preparation capability is read during that scan, not a new scan. C# hidden alias and owner-chain warmup remain at their original per-module awaits. Preserve namespace ordering and `undefined`, the distinction between an omitted positioned resolution and a `null` resolution, deferred names, cache registration and resolved member targets. Target-file fallback restrictions come from the target's already available policy/data, not the use language.

### G8: graph visitors, owners and heritage

```ts
type GraphBodyStage = typeof emitFunctionBodyEdges;
type GraphOwnerStage = typeof emitMemberOwnershipEdges;
type GraphHeritageStage = typeof emitClassInheritanceEdges;
type GraphNamedTypeStage = typeof resolveNamedType;
```

The three pass signatures are `(context: EdgePassContext, functionNodes: DetailedFunctionNode[]) => Promise<void>`, `(context: EdgePassContext, functionNodes: DetailedFunctionNode[], classNodes: DetailedClassNode[]) => Promise<void>`, and `(context: EdgePassContext, classNodes: DetailedClassNode[]) => Promise<void>`. The named-type signature is `(context: EdgePassContext, name: string, node: SyntaxNodeLike, rubyConstructed?: boolean) => SymbolDef | null`. Move `EdgePassContext` and the already-existing `NodeVisitor` type to a leaf, with runtime helpers injected as needed.

Select each full pass/visitor once per file or once per function where the existing visitor is already created. The generic visitor preserves current node order and edge sinks; C++, C#, Go, Java, Kotlin, PHP, Python, Ruby, Rust, Swift, TS/TSX and Zig own the represented variants. Replace an existing visited-node function directly instead of adding a callback within it. Keep alias role and shadowing before call routing, lexical and imported type proof before late recovery, constrained Swift access separate from donated membership, C# partial identity, PHP traits, and inheritance relation labels in the existing order. Preserve the exact `false`/`true`/`undefined` visitor meaning and deferred edge completion.

### G9: completed-graph resolution

```ts
type CompletionStage = typeof emitReceiverCallEdges;
type CallablePrefilterStage = (candidate: ReceiverCallCandidate) => boolean;
```

`CallablePrefilterStage` is the existing `hasCallableNamed` closure, already called by the existing filter. Choose the completion traversal once after module emission; read source/target semantic capabilities from the existing per-file support or member-policy entries at the points the old code inspected them. The generic path uses exact names and the existing member selector; Kotlin, Swift and TS/TSX add only their current property-arity, normalized spelling and overload/visibility work.

Do not group or sort candidates by language, add a project scan, select a registry inside the candidate loop, or create new candidate records. Reuse existing per-module passes and already allocated candidate/context records only when they were already created; keep a capability lazy when the old check was lazy. Preserve Swift name normalization, Kotlin call/property and trailing-lambda facts, TS/TSX overload proof, use-versus-target package identity, edge insertion and removal order, and absent-support behavior.

Slice 3 implements G7-G9 as rows selected once per module, or read from the member policies already selected per file:

- The module walks copy graph-only facts from the `GraphHooks` row of the parsed support: `scopePathType`, `membersNeedReceiver`, `memberOwnerSyntax`, `qualifiedTypeChains`, `namespaceDeclarationMembers`, `positionedAliasProof` and `typeCallsInstantiate`. Go, Rust and Zig gain graph rows for them. The walks read C, C++, JS and TS facts only from this row, because an unmapped `.h` header and an embedded component script can parse as another language than their extension names.
- Facts navigation already reads decide the rest, from the module's member policy: `namespaceScopes`, `namespaceQualifiedTypes`, `positionedImports`, `dottedImports`, `annotationTypes`, `classAttributeMembers`, `innermostNamespaceImports`, `qualifiedTypeNames`, `visibleConstantTypes`, `trailingLambdaCalls`, `callablePropertyArity`, `supertypeEntry`, `constantPathType`, `composedOwnerType`, `aliasesReachDeclarations` and the shared-owner rules. The new `lambdaReceiverThis` and `roleQualifiedImports` facts name behavior that navigation's matching checks share, for slice 4 to read.
- The pre-graph scan selects every module's member policy once (moved from the module loop) and prepares the PHP namespace table when a policy sets `namespaceClassNames`. The completed-graph passes and the member-path fallback read those per-file policies, never a registry per candidate.
- Zig's static-receiver call moved into its `SPECIALIZED_EDGE_PASSES` row. `resolveRubyVisibleConstant` lost its guard, because every caller now selects it from a Ruby-only fact, and `resolveNamedType` lost its `rubyConstructed` flag, which only reached that guard.

### G10: graph import and target arbitration

```ts
type ImportAliasStage = typeof buildImportAliasMaps;
type AddDefinitionEdgeStage = (
  aliasId: string,
  targetFile: FileId,
  exportedName: string,
  label: string,
  imp?: Extract<ImportBinding, { kind: "named" }>,
) => boolean;
```

The second type is the existing `addDefinitionEdge` closure. Select the full alias-map traversal once from the importing module; specialize Rust namespace arbitration and Java's cross-language star spelling while keeping the target's own normalization fact. For the basic graph, reuse the target support already obtained by the existing operation and its selected export/local visibility capability; C/C++ do not allow the old local fallback, Java retains its import resolver visibility check, and the generic path keeps the old fallback.

The Rust namespace decision stays before exported-symbol lookup. A Java importer of a Kotlin target uses the same Kotlin spelling normalization only at the existing guarded point. Do not pre-scan excluded files or use the importing language to decide a target's export visibility. `false` remains a failed edge, with the same resolution-cache key, insertion order and export/local fallback.

Slice 1 keeps these facts as data. The importer's graph import row (`moduleNamedImports` for Rust, `starNamesUseTargetSpelling` for Java) is read once per module, and the basic graph reads the target's `GraphHooks` (`aliasExportOptions` for C and C++, `importResolverVisibility` for Java) once per target file.

### G11: call compatibility

```ts
type ImpactCallBindingStage = typeof callBindingForm;
```

The existing input is `{ languageId: string; callNode: SyntaxNodeLike; source: string; parsedCallsite: ParsedFileContext; file: string; index: ProjectIndex; declarationKind: CallableDeclarationKind | null; ownerTypeName: string | null }`, returning `CallableBinding`. Select from the already parsed callsite's support once per file and pass the function into the existing impact traversal. The generic stage returns the old `"bound"` result; Rust, C# and Python implement the existing UFCS, extension and receiver-proof rules.

Call it only when the bound and unbound signatures differ and the call node exists, as today. Keep the same named-class lookup, declaration kind, arity and missing-callee behavior; do not add an identifier or reference callback.

### G12: importer reachability

```ts
type ReferenceCandidateStage = typeof getCachedReferenceCandidateFiles;
type ImporterWalkStage = typeof importersReachingDefinition;
type ImportProofStage = typeof importCanReferenceDefinition;
```

These preserve the existing candidate-cache signature and `readonly string[]`, `ImporterSearch -> Map<string, string>`, and `(index: ProjectIndex, imp: ImportBinding, def: SymbolDef, exportedNames: readonly string[], languageId: string) => boolean` respectively. Move `ImporterSearch` unchanged to a type leaf. Select a complete importer/candidate traversal once from the definition/use policy; when a resolved target is encountered, use the target's existing support-derived name/visibility capability, not an importer-language guess.

C, C++, C#, Java, Kotlin and Python supply the represented specializations. The generic path keeps the existing reverse reachability, import identity proof and cache. Preserve namespace and re-export paths, C include namespaces, C# directories/global usings, Python dotted-package views, Java/Kotlin spelling, overload proof, cache keys and module order. Reuse `referenceModuleTable.globalNameFiles`; the already-migrated PHP partition must not be reintroduced or rebuilt with another scan.

### G13: occurrence filtering and safety

```ts
type ScopeOccurrenceStage = typeof getCachedScope;
type VerifiedOccurrenceStage = typeof collectVerifiedNamedNodeReferences;
type KeepOccurrence = (binding: Binding, occurrence: Range) => boolean;
type KotlinOccurrenceStage = typeof isKotlinReceiverClaimableCall;
```

`KeepOccurrence` is the existing scope filter callback, not an added callback. Select the full filter or verification visitor once per parsed candidate file; the default retains the existing export-from and generic verification. PHP owns role, canonical-name and trait recovery, C owns function-pointer-field exclusion and linked-declaration checks, and Kotlin owns its implicit-receiver syntax reader. Move complete PHP/C target helpers to their owned modules; retain a foreign parsed-file guard inside a language-owned helper when that file is discovered only after loading.

Keep `filteredScopeOccurrences` ownership, candidate and declaration ordering, the existing named-node visitor count, max-verified cutoff, export proof, receiver uncertainty, provenance, and partial coverage. Move the Kotlin syntax reader and its pure dependencies to a leaf instead of importing the name-policy registry from the reference walker. `null`, `[]`, unverified and unavailable remain distinct.

### G14: reference request, family and candidate collection

```ts
type ReferenceRequestStage = typeof findReferencesInternal;
type PythonCanonicalStage = typeof canonicalizePythonReceiverAttributeDefinition;
type CsharpFamilyStage = typeof findCsharpPartialTypeEquivalents;
type RubyFamilyStage = typeof findRubyReopenedConstantParts;
type CandidateScanStage = typeof collectVerifiedNamedNodeReferences;
```

`findReferencesInternal` takes `(index: ProjectIndex, req: FindReferencesRequest, opts: FindReferencesOptions | undefined, collectionMode: "all" | "usages" | "rename") => Promise<FindReferencesResult>`. Move its request/options types unchanged to a type-only leaf. Select query-level planning from the definition's parsed support; select candidate-file visitors from each candidate's parsed support. Python, C, C#, Ruby, Java, Kotlin, PHP and SCSS implement the represented canonicalization, equivalent-family, occurrence, candidate and coverage operations; the generic stage retains the ordinary request and collection flow.

Do not put a new async `findReferencesInternal` wrapper around an async specialized scanner after parsing. Retain the current async owner and awaits, select existing async helper pointers directly, and move the complete synchronous traversals between those awaits into selected functions. For the inner per-import and per-range decisions, use a selected whole visitor or finite semantic data such as namespace-proof requirements, not a language predicate or new per-occurrence callback.

Keep canonicalization before the reference plan, C# partial and Ruby reopened completeness, C includes and namespace spelling, Python package views and accessor uncertainty, PHP case folding and global names, bounded candidate collection, namespace proof, SCSS pruning, final sorting and all coverage reasons. An unavailable strategy must never become a complete answer; `null`, `undefined`, empty families, `not_found`, and partial coverage keep their original meanings.

## Breaking the `navigation-local.ts` registry cycle

The current full name-policy registry imports `c-family.ts` and `implicit-self.ts`; both import `navigation-local.ts`. Therefore `navigation-local.ts -> name-lookup-policies/index.ts` would close a runtime cycle. It is not enough to move only a type or to import the existing reference registry and hope its transitive imports remain leaf-like.

1. Extract `NamedImportStage`, its existing call-site shape, and any private result types into `name-import-stage-types.ts`, with type-only imports of `ProjectIndex`, `ModuleIndex`, `FileId`, `LanguageSupport`, `SyntaxNodeLike`, `ScopeIndex`, and `GoToResult`.
2. Move the generic named/import arbitration and its private `explicitCallArgumentCount`, `importBindingCoversIndex`, and `starImportGoTo` helpers to a lower `navigation-named-core.ts`; move `toModuleRef` there only if all its existing consumers are migrated. Keep binding/scope helpers such as `definitionForBinding`, `getOrBuildScopeIndex`, `laterLocalShadowsUse`, and the C# name readers in their existing ownership unless a stage actually needs them. Do not create compatibility re-exports after migrating callers.
3. A leaf `name-import-stages/index.ts` selects immutable generic/C/C++/C#/Kotlin/Python stage functions. Stage implementations and the common core do not import `navigation-local.ts`, `navigation-goto.ts`, `name-resolution.ts`, or the full name/member registries at runtime. Existing operations such as `resolveExport`, `resolveImported`, star precedence, C# imports, PHP explicit imports, provenance and Python dotted imports are passed as a single module-lifetime typed dependency bundle, in the style of `MemberLookupDeps`, rather than imported back through an upper consumer. Pass existing state and positional arguments; do not allocate a dependency object or closure for each lookup.
4. The resulting new edges are `name-resolution -> full name registry -> c-family/implicit-self -> navigation-local`, and `navigation-local/callers -> leaf stage registry -> language stage -> named core/types`. The core and language stages have no runtime edge back to the facade or full registry; their dependency bundle is supplied by the consumer. This breaks the proposed new cycle even though unrelated pre-existing imports elsewhere may still form cycles.
5. Migrate every caller, including C-family and `MemberLookupDeps.namedDefinition`, to carry a stage chosen at the enclosing query/file boundary. Do not retain a forwarding facade that performs another registry lookup for every identifier. Run the source-structure cycle tests and a runtime import/initialization test after the split.

Slice 1 implements this split. `navigation-named-core.ts` builds each language's complete stage once from a `NamedImportRules` row (`name-import-stage-types.ts`), and `name-import-stages/` holds the C, C++, C#, Kotlin and Python rows with the leaf selector. The core imports the existing export, import, star and provenance operations from their own lower modules, none of which reaches `navigation-local.ts`, so no dependency bundle is needed. `resolveBareName` reads the stage from its already-selected name policy (`NameLookupPolicy.namedImports`); the other callers select it once from the support the old resolver examined, and the JVM qualified-owner hook selects it when the hook is built.

## No additional hot-path work

- Stage selection is once per query, parsed module, function visitor, or newly loaded target file as specified above. A function already called on each node may be replaced by the selected function with the same signature and call count; a new per-node predicate, registry lookup, factory, wrapper, or closure is not acceptable.
- Reuse existing objects, maps, sets, arrays, scope ownership and lazy caches. No new candidate aggregation, second project scan, copied graph, sort, eager tree projection, eager `node.parent`/`namedChildren`, or per-identifier argument object is allowed. If specialization cannot preserve the current loop without duplication, share coarse sub-traversals and keep only the irreducible language-specific loop; do not hide a new callback behind a generic helper.
- A selected synchronous operation stays synchronous. Replace an existing async callee with the chosen async function directly at the same await; where the owner itself is already async, keep its original await and use selected synchronous operations between awaits. Do not write `async (...args) => await selected(...args)`, add an async factory, or introduce an extra `Promise.resolve`/`then`. Handle mixed sync/async existing hooks with their existing semantics, not a blanket async adapter.
- Use V8 Inspector precise coverage. In isolated base/head processes run identical recorded queries, start `Profiler.startPreciseCoverage` with `{ callCount: true, detailed: true }`, clear coverage before each build/goto/references/graph/impact phase, and compare root-range function counts plus detailed branch ranges by semantic operation.
- Track native parse/query/scope calls, projected-tree `get type`, `get parent`, `get namedChildren`, `childForFieldName`, and `nodeById`. Count actual `ProjectedSyntaxNode` creation using the narrowest precise coverage range containing the `new ProjectedSyntaxNode` anchor in each build; missing function/anchor or non-precise coverage is inconclusive, not zero. Add `node:v8` promise-hook initialization counts around the same isolated phases, with identical observer setup and separately counted observer overhead; inspect changed async paths to establish that no added promise or await is hidden by an unrelated decrease.
- Require equal work and no new per-node dispatcher or new tree-read/allocation counts; explain any function rename by comparing the old operation with its complete replacement, not by dropping the function from the comparison. Timing alone, a sample answer hash, or stable total edge counts cannot establish this contract.

## Parallel implementation and integration

A single integrator first lands the type-only contracts, leaf dependency conventions, inventory boundary treatment, and dedicated stage entry files without activating behavior. The four workers then own disjoint existing files and separate new stage modules. Shared registry/adapter/type wiring is owned only by the integrator, who incorporates each worker's explicit wiring patch before verifying that slice; workers do not independently edit shared registry files.

| Slice                                           | Exclusive existing-file ownership                                                                                                                                                                                                                                                                                                                 | Estimated records |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------: |
| 1: named/import foundations and target safety   | `src/indexer/navigation-local.ts`; `src/graphs/symbol-graph-detailed/import-aliases.ts`; `src/graphs/symbol-graph.ts`; `src/indexer/member-lookup-policies/cpp-receiver.ts`; `src/indexer/member-lookup-policies/csharp-owner.ts`; `src/util/resolution/namespace-specifiers.ts`; `src/util/resolution/csharp.ts`; new named/import stage modules |                24 |
| 2: member/owner navigation                      | `src/indexer/navigation-goto.ts`; new receiver, hierarchy and Ruby/Swift/Go/Python owner-stage modules                                                                                                                                                                                                                                            |                63 |
| 3: detailed graph                               | `src/graphs/symbol-graph-detailed.ts`; `src/graphs/symbol-graph-detailed/edge-passes.ts`; new graph-stage modules                                                                                                                                                                                                                                 |                87 |
| 4: positioned navigation, references and impact | `src/indexer/navigation.ts`; `src/indexer/navigation-references.ts`; `src/impact/call-compatibility.ts`; new positioned/reference/impact-stage modules                                                                                                                                                                                            |                66 |
|                                                 | Total                                                                                                                                                                                                                                                                                                                                             |               240 |

Give each worker exclusive ownership of its new language-specific files even when another slice uses the same language. The integrator alone owns the shared stage type files, registry rows, adapter and inventory/lint configuration; workers provide named integration changes against the prerequisite interface, not competing edits. Existing shared test fixtures that multiple slices need are likewise integrated by one owner.

Merge and verify **1, 2, 3, 4**. Slice 1 establishes cycle-free name/import selection and target-boundary exemptions; slice 2 supplies the receiver and owner traversals consumed by graph/navigation; slice 3 integrates graph visitors; slice 4 integrates positioned, reference and impact consumers. Workers may develop in parallel after the prerequisite, but each final candidate must be wired, built and verified on its actual integrated predecessor, not merely on the common base. The final lint-rule change follows all four.

## Verification for each integrated slice

Use a built candidate checkout and a separately built read-only baseline; never build, check out, write a cache into, or mutate the baseline. Serialize builds, tests and differential runs on the shared machine and cap Vitest at two workers. Record content fingerprints/revisions, identical root/config/extension mappings, native runtime, file selection, cache modes, thread counts, query lists, and all unavailable/error outcomes.

1. Require byte-identical `npm run answers:snapshot:check` and `npm run graph:snapshot:check`; also run `npm run bench:fixtures:check` and `npx vitest run tests/call-form-matrix --maxWorkers=2`, including the report check. Do not regenerate snapshots to approve a refactor difference.
2. Run complete, separate-process base/head differentials using `loadAnswerApi` and `answerProjectRecords` from `scripts/answer-snapshot-lib.mjs`, plus a scratch graph dumper equivalent to `scripts/graph-edge-snapshot.mjs`. Query every parseable identifier/property/shorthand position, every indexed declaration and distinct goto target for references, and all file and detailed graph edges. Compare complete normalized records including status, reasons, order, ranges, provenance, coverage, graph identities and callsites; require zero differences.
3. Use 16 real corpus inputs: Hono (TS), Spectre.Console (C#), Sinatra (Ruby), Flask (Python), Gin (Go), Slim (PHP), Gson (Java), Alamofire (Swift), ripgrep (Rust), Okio (Kotlin), cJSON (C), fmt (C++), ZLS (Zig), Jekyll SCSS, the Flask tutorial SQL project (`examples/tutorial`), and Jekyll Markdown (`docs`). The last two are distinct roots and language filters from the Flask Python and Jekyll SCSS inputs; pin their parent revisions and record the selected files. For graph-only documents, compare real graph records and explicit unsupported navigation results instead of inventing lexical positions.
4. Report file and language counts, parsed/unavailable files, positions, reference targets, file/detailed graph edges and mismatches. Require nonzero intended-language files and queries where navigation is supported, no unreported parse failures or native fallback, and no truncated graph; an unprocessable corpus is a failed gate.
5. Compare `BuildReport` file/cache/backend/worker counts, per-language native parse and scope builds, goto requests/answers, reference candidates/coverage and graph work. On disposable copies and separate base/head cache directories compare cold, memory-warm and disk-warm results after no change, edit, delete, undelete, rename, rename back and restore. Reproduce any ordering difference against an identical baseline mutation before deciding whether it was introduced; never normalize away real ordering.
6. Run the V8 and promise-count contract above on matching targeted and cross-language workloads. Run at least five paired, alternating base/head rounds on a large real project for cold build, no-change update, one-file update, graph build, goto and references; require equal work, investigate repeatable regressions with profiles, and restore the old execution shape.
7. Run focused language, scope, import, navigation, reference, graph, native-semantic-parity, source-structure and cache-invalidation tests for each touched consumer, then the full Vitest suite once after integration and `npm run check` after all slices. An indexed-fact or function-valued language-hook change needs the applicable unique core/language epoch entries and fingerprint coverage per `AGENTS.md`; never rewrite existing epochs. A zero-answer-difference internal refactor needs no user-facing changelog fragment, and any user-visible answer difference blocks this cutover.

## Final lint rule

Once the full inventory has zero non-exempt records, replace the temporary ratchet with `scripts/eslint-rules/no-inline-language-checks.mjs`, wired into `eslint.config.js` as an error for shipped `src/**/*.ts`, excluding only the existing generated/fixture paths. Use TypeScript parser services and symbol/initializer provenance, not a selector that bans every `id` property.

Detect strict and non-strict equality/inequality in both operand orders, optional or computed `id`, destructuring and local aliases, switch cases, and literal/constant array or set `includes`/`has`. Resolve finite constant aliases and declared sets using all registered language IDs, including document formats and newly registered languages. Do not flag dynamic-ID equality, unrelated syntax-node IDs, import-mechanism enums, native availability sets, or the exact existing format/bootstrap/cache-wire and target-grammar safety boundaries; family helpers are allowed only by resolved definition/import provenance. Constrain every exemption by exact file, enclosing function and boundary purpose, never an entire shared directory or an arbitrary new wrapper helper.

RuleTester must cover reversed/optional/computed comparisons, aliases, negation, switches, array/set constants, a newly registered ID, non-language IDs, dynamic addon support, cached wire enums, legitimate family helpers, the named format/CLI boundaries, and the exact target checks above. Assert a new comparison fails in each covered shared subtree and that an exemption cannot be borrowed by another function. Remove the ratchet only in the final independently verified change; the final inventory contains documented exemptions only.

## Appendix: complete baseline record locations

Each entry is `line:column` in the named file at `81e2a0a2`. Multiple columns on one line are distinct AST records, and each of the 240 records appears exactly once.

### G1 (10)

- `src/indexer/navigation-local.ts`: 401:6, 406:5, 417:5, 420:33, 428:45, 449:13, 499:36, 501:9, 512:7, 775:21.

### G2 (11)

- `src/indexer/navigation.ts`: 254:7, 290:7, 295:7, 308:33, 318:5, 375:9, 384:9, 431:9, 444:7, 521:7, 528:64.

### G3 (33)

- `src/indexer/navigation-goto.ts`: 1743:7, 1767:7, 1781:22, 1820:5, 1841:9, 1850:9, 1857:11, 1864:9, 1867:9, 1873:13, 1876:11, 1887:18, 1889:18, 1896:18, 1931:15, 1940:13, 1944:13, 1961:11, 1988:13, 1988:34, 1988:57, 1991:20, 2013:11, 2045:37, 2047:35, 2076:15, 2113:15, 2128:9, 2185:5, 2242:9, 2287:11, 2346:9, 2534:14.

### G4 (15)

- `src/indexer/navigation-goto.ts`: 2805:9, 2826:9, 2833:9, 2841:9, 2993:7, 3153:17, 3383:7, 3408:35, 3427:43, 3428:21, 3442:16, 3514:32, 3518:26, 3538:5, 3658:45.

### G5 (9)

- `src/indexer/navigation-goto.ts`: 5341:9, 5351:9, 5363:9, 5385:9, 5431:9, 5447:7, 5711:7, 5714:7, 5723:7.

### G6 (14)

- `src/indexer/member-lookup-policies/cpp-receiver.ts`: 17:7, 83:7, 135:7.
- `src/indexer/member-lookup-policies/csharp-owner.ts`: 137:34, 177:7, 272:7, 281:15.
- `src/indexer/navigation-goto.ts`: 5061:7, 5119:7, 5159:7, 5212:9, 6379:14, 6573:21.
- `src/util/resolution/namespace-specifiers.ts`: 14:5.

### G7 (23)

- `src/graphs/symbol-graph-detailed.ts`: 230:9, 334:7, 335:7, 344:9, 479:9, 480:11, 531:38, 541:15, 548:13, 548:33, 555:15, 555:35, 565:17, 565:40, 605:11, 659:9, 664:9, 680:13, 692:13, 746:15, 760:15, 784:19, 812:11.

### G8 (53)

- `src/graphs/symbol-graph-detailed/edge-passes.ts`: 320:7, 339:32, 601:7, 601:38, 602:23, 608:23, 645:7, 685:7, 698:7, 705:7, 713:7, 724:7, 791:7, 804:8, 804:35, 810:7, 825:7, 838:55, 1016:8, 1016:35, 1503:11, 1505:11, 1525:27, 1525:56, 1529:11, 1563:23, 1572:32, 1599:13, 1603:29, 1624:11, 1683:9, 1704:15, 1709:15, 1742:11, 1775:13, 1818:13, 1861:11, 1896:11, 1906:13, 1920:11, 1932:11, 1936:11, 1944:11, 2001:18, 2001:47, 2035:21, 2305:18, 2320:7, 2340:7, 2383:9, 2501:7, 2544:9, 2553:9.

### G9 (11)

- `src/graphs/symbol-graph-detailed.ts`: 415:12, 835:30, 840:11, 892:9, 892:32, 903:11, 903:40, 944:11, 950:34, 958:55, 1015:72.

### G10 (6)

- `src/graphs/symbol-graph-detailed/import-aliases.ts`: 172:13, 232:7, 232:32.
- `src/graphs/symbol-graph.ts`: 147:32, 147:54, 155:93.

### G11 (3)

- `src/impact/call-compatibility.ts`: 737:7, 740:7, 743:7.

### G12 (17)

- `src/indexer/navigation-references.ts`: 1169:7, 1187:7, 1192:21, 1192:52, 1213:9, 1438:10, 1444:5, 1446:5, 1452:10, 1493:7, 1583:7, 1600:5, 1616:7, 1616:32, 1636:14, 1646:7, 1891:7.

### G13 (11)

- `src/indexer/navigation-references.ts`: 255:9, 279:9, 306:10, 647:7, 744:11, 823:29, 888:9, 932:9.
- `src/indexer/navigation.ts`: 2343:7, 2482:9, 2681:7.

### G14 (24)

- `src/indexer/navigation.ts`: 741:7, 743:7, 909:7, 961:5, 968:22, 1011:29, 1091:5, 1179:11, 1270:9, 1489:7, 1495:26, 1660:18, 1660:67, 1743:19, 1765:29, 1765:58, 1951:9, 1952:9, 1978:9, 2053:11, 2137:7, 2180:5, 2225:7, 2233:7.
