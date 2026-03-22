# Codegraph Performance Optimization Plans

This document contains detailed, actionable implementation plans for four architectural strategies to massively improve Codegraph's performance, specifically targeting the elimination of Node.js FFI (Foreign Function Interface) overhead and single-threaded CPU blocking.

These plans are written to be self-contained and comprehensive, suitable for a junior engineer or an LLM agent to execute step-by-step.

Current implementation status:
- JS/TS/TSX indexing now uses the native `oxc-parser` fast path for imports, exports, locals, CommonJS bindings, and graph specifier extraction.
- `buildProjectIndex` and incremental indexing use a Piscina worker pool from built JavaScript output, while cache and manifest writes stay on the main thread.
- Remaining Tree-sitter-heavy paths keep query-first extraction and still power navigation, references, chunking, and non-JS/TS languages.
- A custom Tree-sitter N-API addon is no longer the primary acceleration path; the native Oxc parser delivers the same category of native-speed win for the highest-traffic JS/TS workloads with less maintenance overhead.

---

## Plan 1: Native Rust N-API Addon (`napi-rs`) for Tree-sitter
**Objective:** Move AST parsing, querying, and symbol extraction out of Node.js and into a native Rust addon. This eliminates the FFI overhead incurred when JS accesses AST nodes (which currently happens thousands of times per file).

### Implementation Steps:
1. **Initialize `napi-rs` Workspace:**
   - In the monorepo root, run: `npx @napi-rs/cli init packages/codegraph-native`.
   - Update `packages/codegraph-native/package.json` to integrate with the existing monorepo structure.

2. **Add Rust Dependencies:**
   - In `packages/codegraph-native/Cargo.toml`, add:
     - `tree-sitter`
     - `tree-sitter-javascript`, `tree-sitter-typescript`, `tree-sitter-python`, etc.
     - `serde` and `serde_json` for struct serialization.

3. **Define the N-API Interface:**
   - In `packages/codegraph-native/src/lib.rs`, define the return types to match Codegraph's TS interfaces using `#[napi(object)]`:
     ```rust
     #[napi(object)]
     pub struct ExtractedData {
       pub imports: Vec<ImportBinding>,
       pub exports: Vec<ExportEntry>,
       pub locals: Vec<SymbolDef>,
     }
     ```
   - Expose a single native function:
     ```rust
     #[napi]
     pub fn parse_and_extract(source: String, language_id: String) -> ExtractedData { ... }
     ```

4. **Implement Tree-sitter Logic in Rust:**
   - Inside `parse_and_extract`, instantiate a `tree_sitter::Parser` and set the language based on `language_id`.
   - Parse the `source` string to generate a `Tree`.
   - Port the exact Tree-sitter queries currently in `src/languages/definitions/*.ts` into the Rust code.
   - Use `tree_sitter::QueryCursor` to iterate over matches. Because this happens entirely in Rust, walking thousands of nodes takes microseconds.
   - Populate the `ExtractedData` structs and return them. N-API will automatically serialize this into a plain JavaScript object.

5. **Integrate with Node.js `indexer.ts`:**
   - Import the native addon in `src/indexer.ts`.
   - Modify `collectImportsForFile` and `collectLocalsAndExportsFromSource` to use the fast path:
     ```typescript
     import { parse_and_extract } from 'codegraph-native';
     // ...
     if (nativeAddonAvailable && isSupportedLanguage(lang)) {
         return parse_and_extract(source, lang.id);
     }
     // fallback to existing JS tree-sitter logic
     ```

---

## Plan 2: Maximize Tree-sitter Queries (Zero-FFI Filtering)
**Objective:** For code that remains in Node.js, ensure all AST traversal uses Tree-sitter Queries rather than manual tree walking (`node.children`, `node.parent`) to minimize FFI crossings.

### Implementation Steps:
1. **Audit Existing Traversal:**
   - Run a codebase search for manual traversal properties: `grep -rE '\.children|\.parent|\.nextSibling|\.walk\(\)' src/`.
   - Identify areas in `src/indexer.ts`, `src/graphs.ts`, or language definitions where these are used for searching the tree recursively.

2. **Rewrite as Queries:**
   - For any manual search (e.g., finding all function declarations, classes, or imports), write a corresponding Tree-sitter query string.
   - Example: Instead of walking children to find `import_statement`, use `(import_statement) @import`.
   - Update `src/languages/definitions/*.ts` to include these queries if they are missing.

3. **Use Query Cursors & Captures:**
   - Replace manual traversal loops with `query.captures(node)`.
   - Iterate only over the returned array of captures. The C++ engine does the heavy lifting of filtering the tree, returning only the requested nodes to JavaScript.

4. **Batch Property Access:**
   - When processing a captured `node`, avoid accessing `node.text`, `node.startPosition`, and `node.endPosition` repeatedly across different functions.
   - Destructure or access these properties exactly *once* and store them in a plain JS object (e.g., `{ text: node.text, start: node.startPosition }`). Pass this plain object to helper functions instead of the raw Tree-sitter node to prevent additional FFI property lookups.

---

## Plan 3: True Multi-Threading via `worker_threads` (Piscina)
**Objective:** Fan out CPU-bound parsing and indexing tasks across multiple physical cores using Node.js `worker_threads` to achieve true parallelism.

### Implementation Steps:
1. **Install Piscina:**
   - Run `npm install piscina` to add a robust thread-pool manager.

2. **Create a Worker Entrypoint (`src/worker.ts`):**
   - Create a new file dedicated to worker execution.
   - Move the core, heavy file-processing logic from `src/indexer.ts` (the contents of the `mapLimit` callback in `buildIndexFromFileListShared`) into an exported async function.
   - Ensure this function takes only serializable data (e.g., `filePath`, `sourceCode` (if pre-read), `graphOptions`). Do not pass parser instances or complex class instances.

3. **Initialize the Thread Pool:**
   - In `src/indexer.ts`, instantiate the pool:
     ```typescript
     import Piscina from 'piscina';
     const pool = new Piscina({
       filename: new URL('./worker.js', import.meta.url).href,
       maxThreads: opts.threads || os.cpus().length
     });
     ```

4. **Dispatch Tasks:**
   - Replace the `mapLimit` concurrency loop in `buildIndexFromFileListShared` and `buildProjectIndexIncremental` with parallel pool executions:
     ```typescript
     const fileResults = await Promise.all(
       normalizedFiles.map(f => pool.run({ file: f, options: workerOpts }))
     );
     ```

5. **Aggregate Results & Manage Cache:**
   - The worker should return the resolved `ModuleIndex` and `edges` arrays.
   - The main thread collects these and aggregates them into the final `ProjectIndex` and `Graph`.
   - **Crucial:** Keep SQLite database connections and disk cache reading/writing strictly on the main thread to avoid DB locking and race conditions. Only dispatch cache-misses to the workers for parsing.

---

## Plan 4: Swap the Parser for JS/TS (Using Oxc)
**Objective:** Replace Tree-sitter with Oxc (The Oxidation Compiler) for JavaScript and TypeScript files to achieve 50x-100x faster parsing for the most common languages.

### Implementation Steps:
1. **Install Oxc Parser:**
   - Run `npm install @oxc-parser/wasm` (or `@oxc-parser/native` for maximum speed).

2. **Create an Oxc Adapter (`src/languages/oxcAdapter.ts`):**
   - Implement a function `parseAndExtractWithOxc(source: string, filename: string): ModuleIndex`.
   - Call `oxc.parseSync(source, { sourceFilename: filename })`. This returns an ESTree-compliant AST incredibly fast.

3. **Traverse and Extract:**
   - Because Oxc returns a plain JavaScript object representing the AST (or uses a highly optimized WASM bridge), tree walking in JS is very fast (no FFI overhead per node).
   - Write an AST walker (using a simple visitor pattern or recursive function) to extract `imports`, `exports`, and local `SymbolDef` declarations from the Oxc AST.
   - Map these extracted nodes exactly to Codegraph's existing `SymbolDef`, `ImportBinding`, and `ExportEntry` types.

4. **Conditional Fast-Path Dispatch:**
   - In `src/indexer.ts` (inside the `parseFile` or worker logic), add a fast-path interceptor before loading Tree-sitter:
     ```typescript
     if (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.tsx') || file.endsWith('.jsx')) {
         return parseAndExtractWithOxc(source, file);
     }
     // Fallback to Tree-sitter for Python, Go, Rust, Vue, Svelte, etc.
     ```

5. **Maintain Tree-sitter Fallback for Chunking:**
   - Keep the existing JS/TS Tree-sitter language definitions intact. Codegraph's Semantic Chunking feature relies heavily on Tree-sitter's specific concrete syntax tree structure. Use Oxc exclusively for the dependency graph and symbol index generation (which represents 95% of the performance bottleneck in `codegraph index` and `codegraph graph`).
