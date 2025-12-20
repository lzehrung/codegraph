---
name: Add Support for Additional Languages
overview: ""
todos: []
---

# Add Support for Additional Languages

We will add support for the requested languages in the specified priority order. This involves installing the Tree-sitter grammars, creating language definitions, registering them, and adding tests.

## 1. Install Dependencies

Install the Tree-sitter grammars for all requested languages.

- `npm install tree-sitter-html tree-sitter-css tree-sitter-scss tree-sitter-vue tree-sitter-svelte tree-sitter-ruby tree-sitter-go tree-sitter-java tree-sitter-c-sharp tree-sitter-rust`
- Note: `tree-sitter-less` will be checked; if not available, we may use `tree-sitter-css` or a specific package.

## 2. Create Language Definitions

For each language, create a definition file in `src/languages/definitions/` (e.g., `html.ts`, `css.ts`, etc.).
Each definition will implement `LanguageDefinition` and include:

- **Extensions**: File extensions (e.g., `.html`, `.css`, `.vue`).
- **Grammar**: The imported Tree-sitter grammar.
- **Structure**: Configuration for semantic chunking (blocks, split points).
- **Graph**: Queries for imports, exports, locals, and import bindings.

### Priority 1: Web Basics (HTML, CSS, SCSS, LESS)

- **HTML**:
- Imports: `<script src>`, `<link href>`
- Symbols: IDs (maybe classes?)
- **CSS/SCSS/LESS**:
- Imports: `@import`, `url()`
- Symbols: Classes, IDs, Mixins, Variables

### Priority 2: Frameworks (Vue, Svelte)

- **Vue/Svelte**:
- Imports: `import` in script tags, component imports.
- Symbols: Component props, methods.
- *Note*: These may require handling embedded languages (JS/TS/CSS/HTML) within the file.

### Priority 3: Backend/Systems (Ruby, Go, Java, C#, Rust)

- **Ruby**: `require`, `module`, `class`, `def`
- **Go**: `import`, `func`, `type`, `struct`
- **Java**: `import`, `class`, `interface`, `method`
- **C#**: `using`, `namespace`, `class`, `method`
- **Rust**: `use`, `mod`, `fn`, `struct`, `impl`

## 3. Register Languages

Update `src/languages.ts` and `src/bootstrap/treeSitterLanguages.ts` to include the new definitions.

- Import the new definitions.
- Add to `LANG_CONFIGS` (for chunking).
- Add to `LANGUAGE_SUPPORTS` (for graph/symbols).

## 4. Add Tests

For each language:

- Create a sample file in `tests/languages/samples/`.
- Create a test file in `tests/languages/` (e.g., `html.test.ts`) verifying:
- Symbol extraction (locals/exports).
- Import resolution.
- Chunking structure.

## Execution Strategy

We will implement these in batches to ensure quality and manageability:

1.  **Batch 1**: HTML, CSS, SCSS, LESS
2.  **Batch 2**: Vue, Svelte
3.  **Batch 3**: Ruby, Go
4.  **Batch 4**: Java, C#, Rust

We will start with Batch 1.