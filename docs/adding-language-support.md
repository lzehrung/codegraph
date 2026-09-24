# Adding language support

Checklist for landing a new first-class source language without drifting from repo conventions.

## 1. Define the support surface first

- Decide whether the language is source-language parity or graph-first only.
- List the exact syntax and resolution forms you will claim in `docs/language-parity.md` and `docs/scenario-catalog.md`.
- If any limitation is intentional, document it before implementation and cover it with an explicit regression test.

## 2. Wire registration and discovery

- Add the language definition in `src/languages/definitions/<language>.ts`.
- Register it from `src/languages/all.ts`.
- Export support from `src/languages.ts` when the public support surface expects it.
- Confirm `src/bootstrap/tree-sitter-languages.ts` derives the intended chunking config for the new language.
- Add the file extension to discovery patterns in `src/util/project-files.ts` (`DEFAULT_PROJECT_PATTERNS`) and any language-specific resolution helpers under `src/util/`.
- Update CLI help in `src/cli.ts` when a command accepts a language override and cannot derive it from the registered chunking configs.

## 3. Wire the native runtime path

- Add the native grammar dependency in `packages/codegraph-native/Cargo.toml`.
- Register the native language id in `packages/codegraph-native/src/languages.rs` (the registry); `packages/codegraph-native/src/lib.rs` only delegates. Add smoke coverage alongside that registration.
- Rebuild the native addon before trusting any native parity failures.
- If reduced-mode recovery needs language-specific heuristics, register a text import extractor in `src/indexer/imports/text-import-extractors.ts` rather than adding a second grammar backend or a new call site. The registry owns the entry shape (source, sink, context) and the graph and indexer paths both run it.

## 4. Implement the language definition cleanly

- Define chunk blocks, split points, comments, and node-type hints in the language definition.
- Add import, export, local, and import-binding queries that match the real grammar node names. Import-bearing queries use the shared capture vocabulary in `src/languages/graph-captures.ts`: required `@stmt` plus path-bearing `@from`, with optional `@alias`, `@wild`, `@iname`, `@def`, `@ns`, and `@type_kw`. An unknown capture name is a typecheck error. Probe the pinned grammar for the node shapes you match; a query that compiles and matches nothing yields an empty graph rather than an error.
- Implement `classifyDefinition`, `isDeclarationName`, and scope helpers so symbol indexing and navigation stay consistent with other source languages. Reuse the shared hook bodies in `src/languages/definitions/shared.ts`, `js-family.ts`, and `c-family.ts` before writing new ones.
- Cross-language capability data belongs in the table keyed by language id that sits with its subsystem, not in a `LanguageDefinition` field and not in an inlined branch. Reserve `LanguageDefinition` for hooks that need real per-language code.
- Current subsystem tables include `src/util/trivia-tables.ts`, `src/util/member-access-tables.ts`, `src/util/dynamic-import-tables.ts`, `src/indexer/scope-nodes.ts`, `src/indexer/declaration-visibility.ts`, `src/indexer/imports/import-binding-tables.ts`, `src/impact/call-compatibility/providers/profiles.ts`, and `src/document-links/html-forms.ts`. Add a reasoned omission row when the subsystem requires complete language coverage.
- Set `membersAreImplicitlyInScope: true` only when the language runtime resolves a bare member name inside a type body. It defaults to false, so a language whose members need a receiver requires no entry.
- When changing a function-valued language behavior hook, bump `LANGUAGE_BEHAVIOR_EPOCH` in `src/indexer/build-cache/options.ts`. The disk-cache fingerprint deliberately uses this declared epoch rather than hook source text so bundled CLI and library builds share caches. Changes to scope construction, resolution, classification, or export visibility bump `CORE_ALGORITHM_EPOCH` instead.
- Prefer shared pipeline hooks over language-specific branches. Add a language-specific branch only when the grammar shape actually requires it, and say which grammar limitation forces it.
- After parsing, pass `ParsedFileContext.sup` or its language id to consumers. Do not infer the language again from the extension: `.h` files can be C or C++, and custom extension mappings must remain effective.

## 5. Implement import binding and resolution

- Add statement-level parsing helpers in `src/languages/import-statement-parsers.ts` when the query captures a whole statement instead of normalized binding captures.
- Extend the relevant `src/indexer/` module behind the `src/indexer.ts` facade so import bindings normalize into the shared `ImportBinding` model.
- Extend `src/graphs.ts` only where graph and specifier extraction need language-specific recovery.
- Extend `src/util.ts` for language-specific module resolution, package metadata parsing, and caches.
- Keep dynamic or ambiguous cases conservative. Prefer `external` or `not_found` over false-positive navigation.
- When a runtime loader call can be statically mapped through the existing source module resolver, add a bounded adapter and path-fold profile in `src/util/dynamic-import-tables.ts`. The shared runner in `src/util/specifiers.ts` executes the registered adapter. The adapter must avoid executing source, mask comments and strings, mark candidates as heuristic, and ignore computed values it cannot prove. Do not route reflection or runtime plugin APIs through this path unless they have a proven source-file mapping.
- If the language allows more than one package or namespace surface in a single file, model the symbol index per package/namespace entry instead of assuming one file maps to one package.
- Store each externally visible name in `ExportEntry.exportedAs` and the declaration's short name in `target.localName`. Represent visible aliases as separate entries. Do not add a second lookup-name field that every consumer must interpret.

### Sort vs expand

- If a resolver is choosing among multiple candidate files for a named symbol, deterministic sorting is usually enough.
- If a resolver is handling a package-wide or wildcard import that semantically depends on multiple files, expand it to multiple graph edges instead of picking the first candidate.
- When you keep a single-target fallback, add stable ordering before any `candidates[0]` or equivalent first-match pick.
- When you expand to multiple graph edges, add fixtures that prove the behavior across more than one file in the imported package.

## 6. Add fixture coverage in layers

- Add or extend `tests/languages/<language>.test.ts`.
- Add realistic fixtures under `tests/samples/<language>/`.
- Cover syntax permutations in focused tests such as `tests/import-binding-regressions.test.ts` or `tests/resolution.test.ts` when shared suites would hide the exact regression.
- For a dynamic import adapter, cover enabled and disabled graph builds, direct and aliased forms, comments and strings, computed values, heuristic provenance, and any embedded script format that reuses the adapter.
- Update `tests/project-file-discovery.test.ts` if project-file discovery changes.

## 7. Update shared semantic and native suites

- Add shared go-to-definition coverage in `tests/goto.test.ts`.
- Add shared references coverage in `tests/references.test.ts`.
- Add native semantic coverage in `tests/native-semantic-parity.test.ts`.
- Add native parser ownership coverage in `tests/native-parser-ownership.test.ts` when the language uses the native runtime.
- Add reduced-mode safety or recovery coverage when the language has graph-only or regex fallback behavior.
- Use one fixture to check that extraction, `goToDefinition`, `findReferences`, and `buildSymbolGraphDetailed` agree on symbol identity. Include a same-spelled declaration that must not match, plus cold and persisted-cache results when derived data changes.
- Check the native grammar's actual child fields and tokens before writing a language rule. Named-child walks omit operators; a valid parse can still classify a declaration as a different construct.

## 8. Update public docs in the same change

- Update `docs/language-parity.md`.
- Update `docs/scenario-catalog.md`.
- Update `README.md` when supported-language lists or capability summaries changed.
- Update `codegraph-skill/codegraph/SKILL.md` when the repo's agent-facing capability surface changed.

## 9. Verify the real support claim

- Run the focused language suite.
- Run the shared semantic suites.
- Run the native parity and native-only ownership suites if the language uses the native runtime.
- Run `npm run build` after grammar and runtime changes.
- Do not claim support until the docs, fixtures, and verification output all agree.
