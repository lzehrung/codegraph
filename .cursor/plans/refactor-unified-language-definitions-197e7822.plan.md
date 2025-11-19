<!-- 197e7822-b44c-4de9-b41b-1ff91822e82d 7df213ee-31d4-4e25-84f1-f22aa9f537b3 -->
# Refactor: Unified Language Definitions

This plan unifies the configuration for dependency graphing and semantic chunking into a single `LanguageDefinition` structure. This will allow us to auto-generate Tree-sitter queries, reducing maintenance burden and making it easier to add new languages.

## 1. Define Universal Language Interface

Create `src/languages/types.ts` to define the schema:

- **`LanguageDefinition`**:
    - `id`: string
    - `extensions`: string[]
    - `grammar`: Tree-sitter Language
    - `structure`:
        - `blocks`: Node types to keep whole (e.g., classes, functions)
        - `splitPoints`: Node types to split on (e.g., if, loops)
        - `comments`: Node types for comments
    - `graph`:
        - `imports`: Node types/patterns for imports
        - `exports`: Node types/patterns for exports
        - `locals`: Node types for local definitions

## 2. Implement Query Generators

Create `src/languages/queryGenerator.ts`:

- `generateChunkingQuery(def: LanguageDefinition): string`: Generates the SCM string currently found in `*-blocks.scm`.
- `generateGraphQuery(def: LanguageDefinition): string`: Generates the SCM strings currently found in `src/languages.ts`.

## 3. Migrate Existing Languages

Create `src/languages/definitions/` and add:

- `typescript.ts`: Port TS/TSX logic.
- `javascript.ts`: Port JS logic.
- `python.ts`: Port Python logic.

## 4. Update Consumers

- **Chunker**: Update `src/chunking/languageConfig.ts` to accept `LanguageDefinition` and use the generator.
- **Grapher**: Update `src/languages.ts` to use `LanguageDefinition` and the generator.

## 5. Cleanup

- Remove `src/treeSitter/queries/*.scm`.
- Remove hardcoded queries from `src/languages.ts`.

## 6. Verification

- Run existing tests (`chunkFile.behavior.test.ts`, `chunkFile.smoke.test.ts`) to ensure no regression in chunking.
- Run graph tests to ensure no regression in dependency analysis.