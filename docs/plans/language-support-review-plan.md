# Language Support Review Remediation Plan

## Summary

This plan addresses the confirmed language-support gaps from the review:

- Vue/Svelte SFC inline script imports work, but external `<script src="...">` dependencies are dropped by the SFC masking path.
- Astro code dependencies are covered through graph-only extraction.
- SCSS partial resolution does not match documented Sass partial expectations for `@use "./name"` resolving to `_name.scss`.
- `docs/language-parity.md` understates graph support for CSS, Less, Vue, and Svelte.

No public CLI or library API changes are planned. The work is internal extraction/resolution behavior plus tests and docs.

## Phase 1: Lock Current Behavior With Failing Regressions

- [x] Add Vue fixture coverage for `<script src="./logic.ts"></script>` and assert the graph includes an edge to `logic.ts`.
- [x] Add Svelte fixture coverage for `<script src="./logic.ts"></script>` and assert the graph includes an edge to `logic.ts`.
- [x] Add SCSS fixture coverage proving `@use "./variables"` and `@use "./mixins"` resolve to `_variables.scss` and `_mixins.scss`.
- [x] Add or update tests in `tests/languages/vue.test.ts`, `tests/languages/svelte.test.ts`, and `tests/languages/scss.test.ts`.
- [x] Confirm the new tests fail before implementation for the intended reasons, not because of fixture path mistakes.

## Phase 2: Fix Vue And Svelte SFC Dependency Extraction

- [x] Preserve the current script-content masking behavior for JS/TS parsing so inline SFC code still parses as JS/TS without template/style noise.
- [x] Add a graph/specifier path that extracts SFC tag-level dependencies from the original source before or alongside masked script extraction.
- [x] Include external `<script src="...">` for Vue and Svelte as dependency graph edges.
- [x] Keep existing inline `<script>import ...</script>`, Vue `script setup`, and `lang="ts"` behavior unchanged.
- [x] Avoid claiming semantic symbol extraction, go-to-definition, or references for Vue/Svelte templates or component tags; those remain unsupported.

## Phase 3: Fix SCSS Partial Resolution

- [x] Update stylesheet resolution so SCSS imports can resolve Sass partials when the specifier omits the leading underscore.
- [x] Apply the behavior to `@use`, `@forward`, and `@import` for local relative SCSS paths.
- [x] Preserve explicit `_name.scss` resolution and existing CSS/Less behavior.
- [x] Keep unresolved missing imports as external edges.
- [x] Verify native and JS/fallback paths stay aligned for SCSS graph/specifier extraction.

## Phase 4: Align Documentation

- [x] Update `docs/language-parity.md` so CSS, Less, Vue, and Svelte dependency graph support reflects actual tested behavior.
- [x] Keep Vue/Svelte symbol extraction, go-to-definition, and references marked unsupported unless implementation expands them.
- [x] Update `docs/scenario-catalog.md` with explicit scenarios for Vue/Svelte external script `src` edges and SCSS underscore partial resolution.
- [x] Do not update README table of contents unless new README sections are added or renamed.
- [x] Do not update `codegraph-skill/codegraph/SKILL.md` unless CLI flags, commands, or user-visible capabilities change beyond documented language behavior.

## Phase 5: Full Verification

- [x] Run focused tests:
  - [x] `npm test -- --run tests/languages/vue.test.ts tests/languages/svelte.test.ts tests/languages/scss.test.ts`
  - [x] `npm test -- --run tests/languages tests/native-semantic-parity.test.ts`
- [x] Run shared semantic safety tests:
  - [x] `npm test -- --run tests/goto.test.ts tests/references.test.ts`
- [x] Run broader repo gate:
  - [x] `npm run build`
  - [x] `npm run lint`
  - [x] `npm test`
- [x] Re-run graph probes for `tests/samples/vue`, `tests/samples/svelte`, and `tests/samples/scss` and confirm the expected edges appear.
- [x] Check `git diff` to ensure changes are limited to extraction/resolution code, fixtures/tests, and language docs.

## Assumptions

- The implementation should fix real behavior, not only documentation.
- Vue/Svelte SFC dependency graph support means script code imports and external script `src` edges, not full template semantic navigation.
- Astro remains graph-only and does not need changes unless regressions are discovered while touching shared document extraction.
- SCSS Sass partial resolution should be documented and tested as supported once fixed.
