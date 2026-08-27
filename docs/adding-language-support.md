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
- Confirm `src/bootstrap/treeSitterLanguages.ts` derives the intended chunking config for the new language.
- Add the file extension to discovery patterns in `src/util/projectFiles.ts` (`DEFAULT_PROJECT_PATTERNS`) and any language-specific resolution helpers under `src/util/`.
- Update CLI help in `src/cli.ts` when a command accepts a language override and cannot derive it from the registered chunking configs.

## 3. Wire the native runtime path

- Add the native grammar dependency in `packages/codegraph-native/Cargo.toml`.
- Register the native language id in `packages/codegraph-native/src/languages.rs` (the registry); `packages/codegraph-native/src/lib.rs` only delegates. Add smoke coverage alongside that registration.
- Rebuild the native addon before trusting any native parity failures.
- If reduced-mode recovery needs language-specific heuristics, add them in the existing regex/graph-only recovery paths rather than adding a second grammar backend.

## 4. Implement the language definition cleanly

- Define chunk blocks, split points, comments, and node-type hints in the language definition.
- Add import, export, local, and import-binding queries that match the real grammar node names.
- Implement `classifyDefinition`, `isDeclarationName`, and scope helpers so symbol indexing and navigation stay consistent with other source languages.
- When changing a function-valued language behavior hook, bump `LANGUAGE_BEHAVIOR_EPOCH` in `src/indexer/build-cache/options.ts`. The disk-cache fingerprint deliberately uses this declared epoch rather than hook source text so bundled CLI and library builds share caches.
- Prefer shared pipeline hooks over language-specific branches. Add a language-specific branch only when the grammar shape actually requires it.

## 5. Implement import binding and resolution

- Add statement-level parsing helpers in `src/languages/importStatementParsers.ts` when the query captures a whole statement instead of normalized binding captures.
- Extend the relevant `src/indexer/` module behind the `src/indexer.ts` facade so import bindings normalize into the shared `ImportBinding` model.
- Extend `src/graphs.ts` only where graph and specifier extraction need language-specific recovery.
- Extend `src/util.ts` for language-specific module resolution, package metadata parsing, and caches.
- Keep dynamic or ambiguous cases conservative. Prefer `external` or `not_found` over false-positive navigation.
- If the language allows more than one package or namespace surface in a single file, model the symbol index per package/namespace entry instead of assuming one file maps to one package.

### Sort vs expand

- If a resolver is choosing among multiple candidate files for a named symbol, deterministic sorting is usually enough.
- If a resolver is handling a package-wide or wildcard import that semantically depends on multiple files, expand it to multiple graph edges instead of picking the first candidate.
- When you keep a single-target fallback, add stable ordering before any `candidates[0]` or equivalent first-match pick.
- When you expand to multiple graph edges, add fixtures that prove the behavior across more than one file in the imported package.

## 6. Add fixture coverage in layers

- Add or extend `tests/languages/<language>.test.ts`.
- Add realistic fixtures under `tests/samples/<language>/`.
- Cover syntax permutations in focused tests such as `tests/import-binding-regressions.test.ts` or `tests/resolution.test.ts` when shared suites would hide the exact regression.
- Update `tests/project-file-discovery.test.ts` if project-file discovery changes.

## 7. Update shared semantic and native suites

- Add shared go-to-definition coverage in `tests/goto.test.ts`.
- Add shared references coverage in `tests/references.test.ts`.
- Add native semantic coverage in `tests/native-semantic-parity.test.ts`.
- Add native parser ownership coverage in `tests/native-parser-ownership.test.ts` when the language uses the native runtime.
- Add reduced-mode safety or recovery coverage when the language has graph-only or regex fallback behavior.

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
