# Plan: Semantic Code Chunking + Embedding for JS/TS/Python (+ JSON/YAML) with Tree-sitter

## 0. Goals

- Implement **semantic chunking** for:

- JavaScript, TypeScript, TSX, Python (via Tree-sitter queries)

- JSON/YAML/text using a simple line/token-based chunker

- Produce **embedding-ready chunks**:

- Aim for 150–400 tokens per chunk

- Use semantic units: classes, functions, methods, interfaces, enums, namespaces, imports, module vars, comments, docstrings, etc.

- Set up:

- A reusable `chunkFile` function for code

- A `chunkTextFile` for JSON/YAML/other text

- Vitest tests + a debug script

- Integration with dependency graph / vector DB is left as follow-up tasks (but planned for).

---

## 1. Dependencies & basic structure

**Tasks**

- [ ] Ensure these dependencies are in `package.json`:
```jsonc

{

"dependencies": {

"tree-sitter": "^0.22.0",

"tree-sitter-javascript": "^0.20.0",

"tree-sitter-python": "^0.20.0",

"tree-sitter-typescript": "^0.20.0"

},

"devDependencies": {

"typescript": "^5.0.0",

"vitest": "^1.0.0",

"@types/node": "^20.0.0"

}

}

```

- [ ] Ensure `tsconfig.json` includes `src` and `tests` (or `__tests__`) in `include`.

- [ ] Use this directory layout (create as needed):

- `src/treeSitter/queries/javascript-blocks.scm`

- `src/treeSitter/queries/typescript-blocks.scm`

- `src/treeSitter/queries/python-blocks.scm`

- `src/chunking/languageConfig.ts`

- `src/chunking/chunkFile.ts`

- `src/chunking/chunkTextFile.ts`

- `src/bootstrap/treeSitterLanguages.ts`

- `tests/chunkFile.smoke.test.ts`

- (later) `src/indexing/...` for embeddings/vector store

---

## 2. Tree-sitter queries (JS/TS/Python)

### 2.1 `src/treeSitter/queries/javascript-blocks.scm`

**Task**

- [ ] Create `src/treeSitter/queries/javascript-blocks.scm` with:
```scm

;; ================================

;; JavaScript semantic chunk blocks

;; ================================



;; ----- Comments -----

(comment) @chunk.comment





;; ----- Classes -----

(class_declaration

name: (identifier) @chunk.name) @chunk.block.class





;; ----- Standalone function declarations -----

(function_declaration

name: (identifier) @chunk.name) @chunk.block.function





;; ----- Methods inside classes and objects -----

(method_definition

name: (_) @chunk.name

body: (statement_block) @chunk.block.method)





;; ----- Functions / arrows assigned to variables -----

(lexical_declaration

(variable_declarator

name: (identifier) @chunk.name

value: [

(function_expression

body: (statement_block) @chunk.block.function)

(arrow_function

body: (statement_block) @chunk.block.function)

]))



(variable_declaration

(variable_declarator

name: (identifier) @chunk.name

value: [

(function_expression

body: (statement_block) @chunk.block.function)

(arrow_function

body: (statement_block) @chunk.block.function)

]))





;; ----- Functions / arrows assigned via assignment -----

(assignment_expression

left: (_) @chunk.name

right: [

(function_expression

body: (statement_block) @chunk.block.function)

(arrow_function

body: (statement_block) @chunk.block.function)

])





;; ----- Remaining arrow functions with block bodies -----

(arrow_function

body: (statement_block) @chunk.block.function)





;; ----- Remaining function expressions with block bodies -----

(function_expression

body: (statement_block) @chunk.block.function)





;; ==========================================

;; Inner control-flow blocks (for splitting)

;; ==========================================



(if_statement

consequence: (statement_block) @chunk.block.inner)



(if_statement

alternative: (statement_block) @chunk.block.inner)



(for_statement

body: (statement_block) @chunk.block.inner)



(while_statement

body: (statement_block) @chunk.block.inner)



(do_statement

body: (statement_block) @chunk.block.inner)



(try_statement

body: (statement_block) @chunk.block.inner)



(catch_clause

body: (statement_block) @chunk.block.inner)



(finally_clause

body: (statement_block) @chunk.block.inner)





;; ================================

;; Top-level imports & module vars

;; ================================



(program

(import_declaration) @chunk.block.imports)



(program

[

(lexical_declaration

(variable_declarator

name: (identifier) @chunk.name) @chunk.block.module_var)



(variable_declaration

(variable_declarator

name: (identifier) @chunk.name) @chunk.block.module_var)

])

```


---

### 2.2 `src/treeSitter/queries/typescript-blocks.scm`

**Task**

- [ ] Create `src/treeSitter/queries/typescript-blocks.scm` with:
```scm

;; ==================================

;; TypeScript semantic chunk blocks

;; ==================================

;; Reuse JS patterns for functions/classes/methods/etc.

;; Then add TypeScript-specific constructs.



;; ----- Comments -----

(comment) @chunk.comment





;; ----- Classes -----

(class_declaration

name: (identifier) @chunk.name) @chunk.block.class





;; ----- Standalone function declarations -----

(function_declaration

name: (identifier) @chunk.name) @chunk.block.function





;; ----- Methods inside classes and objects -----

(method_definition

name: (_) @chunk.name

body: (statement_block) @chunk.block.method)





;; ----- Functions / arrows assigned to variables -----

(lexical_declaration

(variable_declarator

name: (identifier) @chunk.name

value: [

(function_expression

body: (statement_block) @chunk.block.function)

(arrow_function

body: (statement_block) @chunk.block.function)

]))



(variable_declaration

(variable_declarator

name: (identifier) @chunk.name

value: [

(function_expression

body: (statement_block) @chunk.block.function)

(arrow_function

body: (statement_block) @chunk.block.function)

]))





;; ----- Functions / arrows assigned via assignment -----

(assignment_expression

left: (_) @chunk.name

right: [

(function_expression

body: (statement_block) @chunk.block.function)

(arrow_function

body: (statement_block) @chunk.block.function)

])





;; ----- Remaining arrow functions with block bodies -----

(arrow_function

body: (statement_block) @chunk.block.function)





;; ----- Remaining function expressions with block bodies -----

(function_expression

body: (statement_block) @chunk.block.function)





;; ==========================================

;; Inner control-flow blocks (for splitting)

;; ==========================================



(if_statement

consequence: (statement_block) @chunk.block.inner)



(if_statement

alternative: (statement_block) @chunk.block.inner)



(for_statement

body: (statement_block) @chunk.block.inner)



(while_statement

body: (statement_block) @chunk.block.inner)



(do_statement

body: (statement_block) @chunk.block.inner)



(try_statement

body: (statement_block) @chunk.block.inner)



(catch_clause

body: (statement_block) @chunk.block.inner)



(finally_clause

body: (statement_block) @chunk.block.inner)





;; ----- Interfaces -----

(interface_declaration

name: (type_identifier) @chunk.name) @chunk.block.interface





;; ----- Enums -----

(enum_declaration

name: [

(identifier)

(type_identifier)

] @chunk.name) @chunk.block.enum





;; ----- Type aliases -----

(type_alias_declaration

name: (type_identifier) @chunk.name) @chunk.block.type_alias





;; ----- Namespaces / modules -----

(internal_module

name: (identifier) @chunk.name

body: (statement_block) @chunk.block.namespace)



(module

name: (identifier) @chunk.name

body: (statement_block) @chunk.block.namespace)





;; ================================

;; Top-level imports & module vars

;; ================================



(program

(import_declaration) @chunk.block.imports)



(program

[

(lexical_declaration

(variable_declarator

name: (identifier) @chunk.name) @chunk.block.module_var)



(variable_declaration

(variable_declarator

name: (identifier) @chunk.name) @chunk.block.module_var)

])

```


---

### 2.3 `src/treeSitter/queries/python-blocks.scm`

**Task**

- [ ] Create `src/treeSitter/queries/python-blocks.scm` with:
```scm

;; ================================

;; Python semantic chunk blocks

;; ================================



;; ----- Line comments -----

(comment) @chunk.comment





;; ----- Module-level docstring -----

(module

(expression_statement

(string)) @chunk.block.docstring)





;; ----- Class definitions -----

(class_definition

name: (identifier) @chunk.name

body: (block) @chunk.block.class)





;; ----- Function / method definitions -----

(function_definition

name: (identifier) @chunk.name

body: (block) @chunk.block.function)





;; ==========================================

;; Inner control-flow blocks (for splitting)

;; ==========================================



(if_statement

consequence: (block) @chunk.block.inner)



(if_statement

alternative: (block) @chunk.block.inner)



(for_statement

body: (block) @chunk.block.inner)



(while_statement

body: (block) @chunk.block.inner)



(try_statement

body: (block) @chunk.block.inner)



(except_clause

body: (block) @chunk.block.inner)



(finally_clause

body: (block) @chunk.block.inner)



(with_statement

body: (block) @chunk.block.inner)



(match_statement

body: (block) @chunk.block.inner)





;; ================================

;; Top-level imports & module vars

;; ================================



(module

[

(import_statement) @chunk.block.imports

(import_from_statement) @chunk.block.imports

])



(module

(expression_statement

(assignment

left: (identifier) @chunk.name)) @chunk.block.module_var)

```


---

## 3. Language configuration & Tree-sitter bootstrap

### 3.1 `src/chunking/languageConfig.ts`

**Task**

- [ ] Create `src/chunking/languageConfig.ts`:
```ts

import Parser, { Query, Language } from "tree-sitter";



export type SupportedLanguage = "javascript" | "typescript" | "tsx" | "python";



export interface LanguageConfig {

id: SupportedLanguage;

parser: Parser;

query: Query;

captures: {

name: string;

blockPrefix: string;

innerBlock: string;

comments: string[];

};

}



export function makeLanguageConfig(

id: SupportedLanguage,

tsLanguage: Language,

queryText: string

): LanguageConfig {

const parser = new Parser();

parser.setLanguage(tsLanguage);

const query = new Query(tsLanguage, queryText);



return {

id,

parser,

query,

captures: {

name: "chunk.name",

blockPrefix: "chunk.block.",

innerBlock: "chunk.block.inner",

comments: ["chunk.comment", "chunk.docstring"],

},

};

}

```


---

### 3.2 `src/bootstrap/treeSitterLanguages.ts`

**Task**

- [ ] Create `src/bootstrap/treeSitterLanguages.ts`:
```ts

import fs from "node:fs";

import path from "node:path";

import JavaScript from "tree-sitter-javascript";

import Python from "tree-sitter-python";

import { typescript as TypeScript, tsx as TSX } from "tree-sitter-typescript";

import { LanguageConfig, makeLanguageConfig } from "../chunking/languageConfig";



function readQuery(relPath: string): string {

const fullPath = path.join(__dirname, "..", "treeSitter", "queries", relPath);

return fs.readFileSync(fullPath, "utf8");

}



const jsQuery = readQuery("javascript-blocks.scm");

const tsQuery = readQuery("typescript-blocks.scm");

const pyQuery = readQuery("python-blocks.scm");



export const LANG_CONFIGS: Record<string, LanguageConfig> = {

javascript: makeLanguageConfig("javascript", JavaScript, jsQuery),

typescript: makeLanguageConfig("typescript", TypeScript, tsQuery),

tsx: makeLanguageConfig("tsx", TSX, tsQuery),

python: makeLanguageConfig("python", Python, pyQuery),

};

```


> The agent should adjust the relative paths if your build layout differs (e.g. `dist` vs `src`).

---

## 4. Core chunker for code files: `src/chunking/chunkFile.ts`

**Task**

- [ ] Create `src/chunking/chunkFile.ts` with this initial implementation (agent can refactor/optimize as needed):
```ts

import { QueryMatch, SyntaxNode } from "tree-sitter";

import { LanguageConfig } from "./languageConfig";



export interface Chunk {

id: string;

languageId: string;

filePath?: string;

type: string;

name?: string;

startLine: number; // 1-based

endLine: number; // 1-based

text: string;

tokenCount: number;

}



interface BlockCandidate {

kind: string;

name?: string;

startByte: number;

endByte: number;

startLine: number;

endLine: number;

}



export interface ChunkFileOptions {

language: LanguageConfig;

source: string;

filePath?: string;

minTokens?: number;

maxTokens?: number;

tokenizer?: (text: string) => number;

}



function defaultTokenizer(text: string): number {

if (!text.trim()) return 0;

return text.trim().split(/\s+/).length;

}



export function chunkFile(opts: ChunkFileOptions): Chunk[] {

const {

language,

source,

filePath,

minTokens = 150,

maxTokens = 400,

tokenizer = defaultTokenizer,

} = opts;



const tree = language.parser.parse(source);

const root = tree.rootNode;

const matches: QueryMatch[] = language.query.matches(root);



const mainBlocks: BlockCandidate[] = [];

const innerBlocks: BlockCandidate[] = [];

const comments: BlockCandidate[] = [];



for (const match of matches) {

let nameNode: SyntaxNode | undefined;

let blockNode: SyntaxNode | undefined;

let innerNode: SyntaxNode | undefined;

let blockKind: string | undefined;



for (const capture of match.captures) {

const { name, node } = capture;



if (name === language.captures.name) {

nameNode = node;

}



if (language.captures.comments.includes(name)) {

const [startRow] = node.startPosition;

const [endRow] = node.endPosition;

comments.push({

kind: name === "chunk.docstring" ? "docstring" : "comment",

startByte: node.startIndex,

endByte: node.endIndex,

startLine: startRow + 1,

endLine: endRow + 1,

});

}



if (name === language.captures.innerBlock) {

innerNode = node;

}



if (

name.startsWith(language.captures.blockPrefix) &&

name !== language.captures.innerBlock

) {

blockNode = node;

blockKind = name.slice(language.captures.blockPrefix.length) || node.type;

}

}



if (innerNode) {

const [startRow] = innerNode.startPosition;

const [endRow] = innerNode.endPosition;

innerBlocks.push({

kind: "inner",

startByte: innerNode.startIndex,

endByte: innerNode.endIndex,

startLine: startRow + 1,

endLine: endRow + 1,

});

}



if (blockNode) {

const [startRow] = blockNode.startPosition;

const [endRow] = blockNode.endPosition;

mainBlocks.push({

kind: blockKind ?? "block",

name: nameNode ? nameNode.text : undefined,

startByte: blockNode.startIndex,

endByte: blockNode.endIndex,

startLine: startRow + 1,

endLine: endRow + 1,

});

}

}



mainBlocks.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);

innerBlocks.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);

comments.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);



const preliminaryChunks: Chunk[] = [];

let chunkIdCounter = 0;

const makeChunkId = () =>

`${language.id}:${filePath ?? "unknown"}:${chunkIdCounter++}`;



for (const block of mainBlocks) {

const text = source.slice(block.startByte, block.endByte);

const tokens = tokenizer(text);



if (tokens <= maxTokens) {

preliminaryChunks.push({

id: makeChunkId(),

languageId: language.id,

filePath,

type: block.kind,

name: block.name,

startLine: block.startLine,

endLine: block.endLine,

text,

tokenCount: tokens,

});

continue;

}



const innerInRange = innerBlocks.filter(

(ib) =>

ib.startByte > block.startByte &&

ib.endByte < block.endByte

);



if (innerInRange.length === 0) {

splitLargeBlockSimple(

block,

source,

tokenizer,

maxTokens,

makeChunkId,

preliminaryChunks,

language.id,

filePath

);

} else {

splitLargeBlockUsingInnerBlocks(

block,

innerInRange,

source,

tokenizer,

maxTokens,

makeChunkId,

preliminaryChunks,

language.id,

filePath

);

}

}



for (const c of comments) {

const text = source.slice(c.startByte, c.endByte);

const tokens = tokenizer(text);

if (tokens === 0) continue;

preliminaryChunks.push({

id: makeChunkId(),

languageId: language.id,

filePath,

type: c.kind,

startLine: c.startLine,

endLine: c.endLine,

text,

tokenCount: tokens,

});

}



preliminaryChunks.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);



const mergedChunks = mergeSmallChunks(

preliminaryChunks,

minTokens,

maxTokens,

tokenizer

);



const finalChunks = fillGapsWithMiscChunks(

mergedChunks,

source,

language.id,

filePath,

tokenizer,

minTokens,

maxTokens,

makeChunkId

);



return finalChunks;

}



function splitLargeBlockSimple(

block: BlockCandidate,

source: string,

tokenizer: (text: string) => number,

maxTokens: number,

makeChunkId: () => string,

out: Chunk[],

languageId: string,

filePath?: string

) {

const text = source.slice(block.startByte, block.endByte);

const lines = text.split(/\r?\n/);



let currentStartLine = block.startLine;

let currentLines: string[] = [];

let currentTokens = 0;



const flush = () => {

if (currentLines.length === 0) return;

const chunkText = currentLines.join("\n");

const tokenCount = tokenizer(chunkText);

const endLine = currentStartLine + currentLines.length - 1;

out.push({

id: makeChunkId(),

languageId,

filePath,

type: block.kind,

name: block.name,

startLine: currentStartLine,

endLine,

text: chunkText,

tokenCount,

});

currentLines = [];

currentTokens = 0;

};



for (let i = 0; i < lines.length; i++) {

const line = lines[i];

const lineTokens = tokenizer(line);

if (currentTokens + lineTokens > maxTokens && currentLines.length > 0) {

flush();

currentStartLine = block.startLine + i;

}

currentLines.push(line);

currentTokens += lineTokens;

}



flush();

}



function splitLargeBlockUsingInnerBlocks(

block: BlockCandidate,

innerBlocks: BlockCandidate[],

source: string,

tokenizer: (text: string) => number,

maxTokens: number,

makeChunkId: () => string,

out: Chunk[],

languageId: string,

filePath?: string

) {

const boundaries = new Set<number>();

boundaries.add(block.startByte);

boundaries.add(block.endByte);

for (const ib of innerBlocks) {

boundaries.add(ib.startByte);

boundaries.add(ib.endByte);

}

const sorted = Array.from(boundaries).sort((a, b) => a - b);



type Segment = { startByte: number; endByte: number };

const segments: Segment[] = [];



for (let i = 0; i < sorted.length - 1; i++) {

const startByte = sorted[i];

const endByte = sorted[i + 1];

if (endByte <= startByte) continue;

const segText = source.slice(startByte, endByte);

if (!segText.trim()) continue;

segments.push({ startByte, endByte });

}



if (segments.length === 0) {

splitLargeBlockSimple(

block,

source,

tokenizer,

maxTokens,

makeChunkId,

out,

languageId,

filePath

);

return;

}



let currentStart = segments[0].startByte;

let currentEnd = segments[0].endByte;

let currentText = source.slice(currentStart, currentEnd);

let currentTokens = tokenizer(currentText);



const pushChunk = () => {

const chunkText = source.slice(currentStart, currentEnd);

const tokenCount = tokenizer(chunkText);

const [startRowZero] = locateLineAndColFromByte(source, currentStart);

const [endRowZero] = locateLineAndColFromByte(source, currentEnd);



out.push({

id: makeChunkId(),

languageId,

filePath,

type: block.kind,

name: block.name,

startLine: startRowZero + 1,

endLine: endRowZero + 1,

text: chunkText,

tokenCount,

});

};



for (let i = 1; i < segments.length; i++) {

const seg = segments[i];

const segText = source.slice(seg.startByte, seg.endByte);

const segTokens = tokenizer(segText);



if (currentTokens + segTokens > maxTokens && currentTokens > 0) {

pushChunk();

currentStart = seg.startByte;

currentEnd = seg.endByte;

currentText = segText;

currentTokens = segTokens;

} else {

currentEnd = seg.endByte;

currentText += segText;

currentTokens += segTokens;

}

}



pushChunk();

}



function locateLineAndColFromByte(

source: string,

byteOffset: number

): [number, number] {

let line = 0;

let col = 0;

for (let i = 0; i < source.length && i < byteOffset; i++) {

const ch = source[i];

if (ch === "\n") {

line++;

col = 0;

} else {

col++;

}

}

return [line, col];

}



function mergeSmallChunks(

chunks: Chunk[],

minTokens: number,

maxTokens: number,

tokenizer: (text: string) => number

): Chunk[] {

if (chunks.length === 0) return [];



const merged: Chunk[] = [];

let i = 0;



while (i < chunks.length) {

let current = { ...chunks[i] };

i++;



while (current.tokenCount < minTokens && i < chunks.length) {

const next = chunks[i];

const combinedText = current.text + "\n" + next.text;

const combinedTokens = tokenizer(combinedText);

if (combinedTokens > maxTokens) break;



current = {

...current,

endLine: next.endLine,

text: combinedText,

tokenCount: combinedTokens,

type:

current.type === next.type

? current.type

: `${current.type}+${next.type}`,

name: current.name ?? next.name,

};

i++;

}



merged.push(current);

}



return merged;

}



function fillGapsWithMiscChunks(

chunks: Chunk[],

source: string,

languageId: string,

filePath: string | undefined,

tokenizer: (text: string) => number,

minTokens: number,

maxTokens: number,

makeChunkId: () => string

): Chunk[] {

if (chunks.length === 0) {

const tokens = tokenizer(source);

if (tokens === 0) return [];

return [

{

id: makeChunkId(),

languageId,

filePath,

type: "misc",

startLine: 1,

endLine: source.split(/\r?\n/).length,

text: source,

tokenCount: tokens,

},

];

}



const byLine = source.split(/\r?\n/);

const lastLine = byLine.length;

const result: Chunk[] = [];

let currentLine = 1;



const pushMiscRange = (startLine: number, endLine: number) => {

if (startLine > endLine) return;

const text = byLine.slice(startLine - 1, endLine).join("\n");

const tokens = tokenizer(text);

if (tokens === 0) return;



result.push({

id: makeChunkId(),

languageId,

filePath,

type: "misc",

startLine,

endLine,

text,

tokenCount: tokens,

});

};



for (const chunk of chunks) {

if (chunk.startLine > currentLine) {

pushMiscRange(currentLine, chunk.startLine - 1);

}

result.push(chunk);

currentLine = chunk.endLine + 1;

}



if (currentLine <= lastLine) {

pushMiscRange(currentLine, lastLine);

}



const final = mergeSmallChunks(result, minTokens, maxTokens, tokenizer);

return final;

}

```


---

## 5. Simple text/config chunker: `src/chunking/chunkTextFile.ts`

**Task**

- [ ] Create `src/chunking/chunkTextFile.ts`:
```ts

import { Chunk } from "./chunkFile";



export interface TextChunkOptions {

source: string;

filePath?: string;

languageId?: string; // e.g. "json", "yaml", "text"

minTokens?: number;

maxTokens?: number;

tokenizer?: (text: string) => number;

}



function defaultTokenizer(text: string): number {

if (!text.trim()) return 0;

return text.trim().split(/\s+/).length;

}



export function chunkTextFile(opts: TextChunkOptions): Chunk[] {

const {

source,

filePath,

languageId = "text",

minTokens = 150,

maxTokens = 400,

tokenizer = defaultTokenizer,

} = opts;



const lines = source.split(/\r?\n/);

const chunks: Chunk[] = [];

let chunkId = 0;



let currentLines: string[] = [];

let currentTokens = 0;

let currentStartLine = 1;



const pushChunk = () => {

if (currentLines.length === 0) return;

const text = currentLines.join("\n");

const tokenCount = tokenizer(text);

if (tokenCount === 0) return;

const endLine = currentStartLine + currentLines.length - 1;

chunks.push({

id: `${languageId}:${filePath ?? "unknown"}:${chunkId++}`,

languageId,

filePath,

type: "text",

startLine: currentStartLine,

endLine,

text,

tokenCount,

});

currentLines = [];

currentTokens = 0;

};



for (let i = 0; i < lines.length; i++) {

const line = lines[i];

const lineTokens = tokenizer(line);

if (currentTokens + lineTokens > maxTokens && currentLines.length > 0) {

pushChunk();

currentStartLine = i + 1;

}

currentLines.push(line);

currentTokens += lineTokens;

}



pushChunk();



// Optionally merge tiny chunks (reuse logic in chunkFile if desired)

return chunks;

}

```


---

## 6. Vitest setup & smoke tests

### 6.1 `vitest.config.ts`

**Task**

- [ ] Create `vitest.config.ts` (basic config):
```ts

import { defineConfig } from "vitest/config";



export default defineConfig({

test: {

globals: true,

environment: "node",

},

});

```


Add a script in `package.json`:

```jsonc

{

"scripts": {

"test": "vitest"

}

}

```

---

### 6.2 Smoke tests: `tests/chunkFile.smoke.test.ts`

**Task**

- [ ] Create `tests/chunkFile.smoke.test.ts`:
```ts

import { describe, it, expect } from "vitest";

import { chunkFile } from "../src/chunking/chunkFile";

import { LANG_CONFIGS } from "../src/bootstrap/treeSitterLanguages";



const testTokenizer = (text: string) =>

text.trim() ? text.trim().split(/\s+/).length : 0;



function logChunks(label: string, chunks: ReturnType<typeof chunkFile>) {

// eslint-disable-next-line no-console

console.log(`\n== ${label} ==`);

for (const c of chunks) {

const namePart = c.name ? ` (${c.name})` : "";

// eslint-disable-next-line no-console

console.log(

`[${c.languageId}] ${c.type}${namePart} [${c.startLine}-${c.endLine}] tokens=${c.tokenCount}`

);

}

}



describe("chunkFile smoke tests", () => {

it("chunks JavaScript", () => {

const source = `

// Top comment about Foo



import fs from "fs";



const API_BASE_URL = "https://example.com";



class Foo {

constructor(id) {

this.id = id;

}



bar(x) {

if (x > 0) {

return x;

}

return -x;

}

}



// standalone function

function baz(y) {

return y * 2;

}

`.trimStart();



const chunks = chunkFile({

language: LANG_CONFIGS.javascript,

source,

filePath: "sample.js",

minTokens: 1,

maxTokens: 1000,

tokenizer: testTokenizer,

});



logChunks("JavaScript", chunks);



expect(chunks.some((c) => c.type === "comment")).toBe(true);

expect(chunks.some((c) => c.type === "imports")).toBe(true);

expect(chunks.some((c) => c.type === "module_var" && c.name === "API_BASE_URL")).toBe(true);

expect(chunks.some((c) => c.type === "class" && c.name === "Foo")).toBe(true);

expect(chunks.some((c) => c.type === "method" && c.name === "bar")).toBe(true);

expect(chunks.some((c) => c.type === "function" && c.name === "baz")).toBe(true);

});



it("chunks TypeScript", () => {

const source = `

import type { Config } from "./types";



interface User {

id: string;

name: string;

}



enum Role {

Admin,

User,

}



type UserId = string;



class Service {

constructor(private id: UserId) {}



getRole(user: User): Role {

return Role.User;

}

}



function helper(x: number): number {

return x * 2;

}

`.trimStart();



const chunks = chunkFile({

language: LANG_CONFIGS.typescript,

source,

filePath: "sample.ts",

minTokens: 1,

maxTokens: 1000,

tokenizer: testTokenizer,

});



logChunks("TypeScript", chunks);



expect(chunks.some((c) => c.type === "imports")).toBe(true);

expect(chunks.some((c) => c.type === "interface" && c.name === "User")).toBe(true);

expect(chunks.some((c) => c.type === "enum" && c.name === "Role")).toBe(true);

expect(chunks.some((c) => c.type === "type_alias" && c.name === "UserId")).toBe(true);

expect(chunks.some((c) => c.type === "class" && c.name === "Service")).toBe(true);

expect(chunks.some((c) => c.type === "function" && c.name === "helper")).toBe(true);

});



it("chunks Python with docstrings", () => {

const source = `

"""Module docstring explaining the purpose of this file."""



import os

from pathlib import Path



CONFIG_PATH = Path("config.yml")



class Foo:

"""Class docstring for Foo."""



def method(self, x):

"""Method docstring."""

if x > 0:

return x

return -x





def top_level(y):

"""Top-level function docstring."""

for i in range(y):

print(i)

`.trimStart();



const chunks = chunkFile({

language: LANG_CONFIGS.python,

source,

filePath: "sample.py",

minTokens: 1,

maxTokens: 1000,

tokenizer: testTokenizer,

});



logChunks("Python", chunks);



expect(chunks.some((c) => c.type === "docstring")).toBe(true);

expect(chunks.some((c) => c.type === "imports")).toBe(true);

expect(chunks.some((c) => c.type === "module_var" && c.name === "CONFIG_PATH")).toBe(true);



const classChunk = chunks.find((c) => c.type === "class" && c.name === "Foo");

expect(classChunk).toBeDefined();



const methodChunk = chunks.find(

(c) => c.type === "function" && c.name === "method"

);

expect(methodChunk).toBeDefined();



const topLevelFunc = chunks.find(

(c) => c.type === "function" && c.name === "top_level"

);

expect(topLevelFunc).toBeDefined();



const docstringChunks = chunks.filter((c) => c.type === "docstring");

expect(docstringChunks.length).toBe(1);

});

});

```


---

## 7. Follow-up tasks (no code yet, just TODOs)

These can be new plan items later:

- [ ] Add `embedAndIndexFile.ts` and `embedAndIndexRepo.ts` that:

- Detect language by extension, choose `chunkFile` vs `chunkTextFile`.

- Use an embedding client to embed `chunk.text`.

- Store into a vector DB along with metadata from `Chunk`.

- [ ] Integrate existing dependency graph library:

- For each `Chunk`, attach symbol/import metadata.

- [ ] Implement a small search API/CLI that:

- Takes a query -> embeds -> queries vector DB -> returns relevant chunks.