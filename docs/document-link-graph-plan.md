# Document Link Graph Plan

Goal: add robust graph support for major document/template formats, including Markdown (`.md`), MDX (`.mdx`), Astro (`.astro`), Handlebars (`.hbs`), reStructuredText (`.rst`), and AsciiDoc (`.adoc`), while keeping the feature graph-first and avoiding unsupported semantic claims.

## Implementation

- [x] Confirm and document edge semantics for document links versus assets/embeds.
- [x] Register Markdown and MDX as supported graph-first file types.
- [x] Extend default file discovery to include `.md` and `.mdx`.
- [x] Extend path resolution candidates so relative document links can resolve to `.md` and `.mdx`.
- [x] Add shared document-link extraction helpers for Markdown and MDX.
- [x] Reuse existing HTML-style extraction for raw HTML anchors inside Markdown/MDX where appropriate.
- [x] Support core Markdown link shapes:
  - [x] Inline links: `[text](./guide.md)`
  - [x] Reference-style links: `[text][guide]` with `[guide]: ./guide.md`
  - [x] Autolinks/path-like links when they are local and static
- [x] Support core MDX link/import shapes:
  - [x] Markdown links in MDX content
  - [x] Static ESM imports/exports with local specifiers
  - [x] Raw HTML anchor tags in MDX content
- [x] Keep external URLs, hash-only anchors, and unsupported schemes out of local file-edge resolution.
- [x] Avoid duplicate edges when multiple extraction paths produce the same specifier.

## Tests

- [x] Add Markdown language/parity tests.
- [x] Add MDX language/parity tests.
- [x] Add Markdown sample fixtures for local docs, nested docs, references, anchors, and external links.
- [x] Add MDX sample fixtures for local docs, local imports, raw HTML anchors, anchors, and external links.
- [x] Update project file discovery tests to cover `.md` and `.mdx`.
- [x] Add regression coverage for duplicate extraction paths where relevant.

## Docs

- [x] Fix the existing HTML dependency-graph parity entry to match current behavior.
- [x] Add Markdown and MDX rows to `docs/language-parity.md`.
- [x] Add Markdown and MDX scenarios to `docs/scenario-catalog.md`.
- [x] Update `README.md` supported-language and graph-capability docs.
- [x] Update `codegraph-skill/codegraph/SKILL.md` so capability docs stay aligned.

## Verification

- [x] Run targeted language, graph, and discovery tests.
- [x] Fix regressions from targeted runs.
- [x] Run one broader integration pass if targeted coverage is clean.
- [x] Mark completed checklist items before closing the work.

## Expansion

- [x] Extend graph-first support to Astro.
- [x] Extend graph-first support to Handlebars.
- [x] Extend graph-first support to reStructuredText.
- [x] Extend graph-first support to AsciiDoc.
- [x] Add fixtures and language tests for Astro, Handlebars, reStructuredText, and AsciiDoc.
- [x] Update docs for the expanded graph-first document/template set.
