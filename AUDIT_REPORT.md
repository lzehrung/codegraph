# Opportunities for Improvement Report

## 1. Logic Accuracy & Robustness

### Fragile Regex-based Comment Stripping
**Severity:** High
**Location:** `src/util.ts` (`stripJsLikeComments`, `stripPythonCommentsAndStrings`)
**The Issue:**
The functions use regular expressions to strip comments and strings. This is known to be fragile and can be tricked by strings containing comment markers (e.g. `var url = "http://example.com";`) or complex nesting. While fast, it risks incorrect parsing of module specifiers in "fast mode".
**The Fix:**
Use a robust lexer or the existing `tree-sitter` parsers (which are already used elsewhere) even for this task, or improve the regex to be more context-aware if performance is paramount.
```typescript
// Better regex or just use tree-sitter:
// If staying with regex, ensure it doesn't match inside strings.
// But really, since we have tree-sitter, use it:
import Parser from "tree-sitter";
// ... use Parser to traverse and extract what's needed, skipping comments.
```

### Python Relative Import Resolution
**Severity:** Medium
**Location:** `src/graphs.ts`, `src/util.ts` (`resolvePythonModule`)
**The Issue:**
The logic relies on `split('.')` and `filter(Boolean)` on module names. For relative imports like `..`, this results in an empty path which happens to work for the parent directory but relies on implicit behavior of `relDots`. The logic in `collectEdgesForFile` passing `moduleName` derived from `spec` can be confusing.
**The Fix:**
Explicitly handle `.` and `..` without relying on side-effects of string splitting.
```typescript
// In src/util.ts
export async function resolvePythonModule(
  projectRoot: string,
  fromFile: string,
  moduleName: string | null,
  relativeDots: number,
): Promise<FileId | { external: string }> {
  // ...
  let baseDir = anchor;
  // Explicitly walk up
  for (let i = 0; i < Math.max(0, relativeDots - 1); i++) {
     baseDir = path.dirname(baseDir);
  }

  if (!moduleName) {
     // Handle case where it's just a relative import like 'from .. import'
     return resolvePackageInit(baseDir);
  }
  // ...
}
```

### Default Language Support
**Severity:** Medium
**Location:** `src/languages.ts` (`supportForFile`)
**The Issue:**
`supportForFile` defaults to `TS_SUPPORT` if the extension is not matched. This can cause the parser to try parsing binary files, images, or unknown text files as TypeScript, leading to errors or garbage data.
**The Fix:**
Return `undefined` or a dedicated `UnknownSupport` that does nothing.
```typescript
export function supportForFile(filename: string): LanguageSupport | undefined {
  const ext = path.extname(filename).toLowerCase();
  // ...
  return LANGUAGE_SUPPORTS.find((s) => s.matchExts.includes(ext)); // Remove default fallback
}
```

### Docstring Extraction Fragility
**Severity:** Low
**Location:** `src/indexer.ts` (`extractLeadingDocstring`)
**The Issue:**
The function iterates backwards line-by-line from the definition to find comments. This is sensitive to whitespace and mixed comment styles and might capture unrelated comments.
**The Fix:**
Use `tree-sitter`'s `previousSibling` or `previousNamedSibling` to check if it's a comment node.
```typescript
// In collectLocalsAndExportsFromSource
const node = ...; // Get the definition node
let prev = node.previousSibling;
while (prev && (prev.type === 'comment' || prev.type.includes('comment'))) {
  // Capture comment text
  prev = prev.previousSibling;
}
```

## 2. TypeScript Type Safety

### Implicit Any and Unsafe Casts
**Severity:** Medium
**Location:** `src/indexer.ts`, `src/util.ts`, `src/graphs.ts`
**The Issue:**
There are multiple usages of `any` (implicit or explicit) and `as unknown`. For example `loadJSON` returns `Promise<T | null>` where `T` defaults to `any`.
**The Fix:**
Use `unknown` and type guards (Zod or similar validation) for external data.
```typescript
// src/util.ts
export async function loadJSON<T = unknown>(p: string): Promise<T | null> {
  // ...
}
```

### Circular Dynamic Import
**Severity:** Low
**Location:** `src/indexer.ts` (`buildProjectIndexFromExport`)
**The Issue:**
The function dynamically imports `./indexer.js` to call `buildProjectIndex`. This introduces a circular dependency on the compiled output and is brittle.
**The Fix:**
Call the function directly since it is in the same module.
```typescript
// src/indexer.ts
async function buildProjectIndexFromExport(
  projectRoot: string,
  opts?: BuildOptions,
): Promise<ProjectIndex> {
  return buildProjectIndex(projectRoot, opts);
}
```

## 3. Test Coverage Gaps

### Missing Interface Locals in TypeScript
**Severity:** Low
**Location:** `src/languages/definitions/typescript.ts`
**The Issue:**
The `locals` query in `TYPESCRIPT_DEF` does not include `interface_declaration` or `type_alias_declaration`. While `src/indexer.ts` uses a fallback scope builder for TS that *does* capture them, the query definition is misleading and potential dead code or bug source if the logic changes to use the query.
**The Fix:**
Update the query to include types.
```typescript
  locals: `
    (function_declaration name: (identifier) @name)
    (class_declaration name: (identifier) @name)
    (variable_declarator name: (identifier) @name)
    (interface_declaration name: (type_identifier) @name)
    (type_alias_declaration name: (type_identifier) @name)
  `,
```

### Performance Testing
**Severity:** Medium
**Location:** `tests/`
**The Issue:**
There are no explicit benchmarks or stress tests for large repositories to verify the memory usage of parallel operations.

## 4. Performance Optimizations

### Inefficient Concurrency Control
**Severity:** High
**Location:** `src/graphs.ts` (`mapLimit`)
**The Issue:**
The `mapLimit` implementation in `src/graphs.ts` uses `Promise.all(items.map(...))` which creates all `N` promises immediately, even if they are waiting on a semaphore. For large `N` (many files), this causes high memory pressure.
**The Fix:**
Use the streaming/recursive approach found in `src/indexer.ts`.
```typescript
// src/util.ts
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  // Use the implementation from src/indexer.ts
}
```

### Synchronous File Reading
**Severity:** Medium
**Location:** `src/languages.ts` (`readFileSample`)
**The Issue:**
`readFileSample` uses `fs.readFileSync`. In a high-concurrency environment or when processing many C/C++ files, blocking the event loop is detrimental.
**The Fix:**
Use `fs.promises.readFile`.
```typescript
async function readFileSample(filePath: string): Promise<string | null> {
  try {
    const contents = await fs.promises.readFile(filePath, "utf8");
    return contents.slice(0, HEADER_SAMPLE_SIZE);
  } catch {
    return null;
  }
}
```

### Redundant File Reading
**Severity:** Medium
**Location:** `src/graphs.ts` -> `src/indexer.ts`
**The Issue:**
`collectGraph` calls `collectEdgesForFile`. `collectEdgesForFile` calls `prepareParserInput` which reads the file. `buildProjectIndex` also reads the file. Files are read multiple times.
**The Fix:**
Pass the file content (source) down the stack if it has already been read. `collectEdgesForFile` already accepts `opts.parsed`, so ensure callers provide it when available.
