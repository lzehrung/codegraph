# Codegraph vs Graphify Comparison

Date: 2026-05-14

This report compares the current `codegraph` checkout against `safishamsi/graphify`, with extra attention to Graphify's broader language surface and its "RAG" positioning. It also considers whether Codegraph should use the local `@lzehrung/rag-search-core` library from `../rag-search-simple-2/packages/core`, which is already integrated by `../code-review-agent/code-navigation`.

## Sources Reviewed

- Codegraph local checkout: `4f5147e`, package version `1.8.67`.
- Graphify upstream checkout: `safishamsi/graphify@5f9ea2b`, package version `0.7.16`.
- Graphify README and docs: [README](https://github.com/safishamsi/graphify/blob/5f9ea2b/README.md), [how it works](https://github.com/safishamsi/graphify/blob/5f9ea2b/docs/how-it-works.md), [architecture](https://github.com/safishamsi/graphify/blob/5f9ea2b/ARCHITECTURE.md), [pyproject](https://github.com/safishamsi/graphify/blob/5f9ea2b/pyproject.toml).
- Codegraph docs: [README](README.md), [CLI reference](docs/cli.md), [language parity](docs/language-parity.md), [how it works](docs/how-it-works.md).
- Existing local RAG/code-navigation stack: [rag-search-core README](../rag-search-simple-2/packages/core/README.md), [code-navigation README](../code-review-agent/code-navigation/README.md).

## Executive Summary

Graphify has a broader product surface than Codegraph: one-command report generation, MCP serving, watch/update workflows, global graphs, many agent installers, media/document ingestion, and a simple graph query experience. It is strong as a "make a knowledge artifact from this folder" tool.

Codegraph is stronger as a deterministic code-intelligence engine. It has deeper code semantics, explicit language parity docs, symbol navigation, references, PR impact analysis, review bundles, SQLite export, a native Tree-sitter runtime, and a typed library API. Codegraph is already closer to a reliable code-review/navigation substrate than Graphify.

The highest-ROI path is not to copy Graphify's implementation. It is to keep Codegraph as the structural code engine and add Graphify-like workflow surfaces around it:

1. A lightweight vectorless graph search layer built from Codegraph's existing graph, symbol, text, and SQLite artifacts.
2. A first-class optional RAG/search layer backed by `@lzehrung/rag-search-core` for semantic/vector recall when needed.
3. A generated markdown report artifact.
4. MCP tools over graph/index/search/RAG artifacts.
5. Tiered language expansion with explicit parity claims.
6. Optional watch/update/global/team artifact workflows.

## Important Correction: Graphify Is Not Vector RAG

Graphify advertises "rag" and "graphrag" in package keywords, but its docs explicitly say it does not use embeddings or a vector database. Semantic similarity is represented as LLM-extracted graph edges, and graph traversal is the retrieval mechanism. See Graphify's "No embeddings needed" section in [docs/how-it-works.md](https://github.com/safishamsi/graphify/blob/5f9ea2b/docs/how-it-works.md#L26-L29).

The MCP/query implementation I inspected supports lexical scoring plus BFS/DFS traversal over the graph, exposed through tools such as `query_graph`, `get_node`, and `shortest_path` in [graphify/serve.py](https://github.com/safishamsi/graphify/blob/5f9ea2b/graphify/serve.py#L57-L240) and [tool registration](https://github.com/safishamsi/graphify/blob/5f9ea2b/graphify/serve.py#L319-L531).

By contrast, `@lzehrung/rag-search-core` is an actual hybrid RAG library with LanceDB vectors, BM25, optional KG scoring, prepared ingest, structure-aware retrieval, rerank support, timings, and explicit runtime configuration. See [rag-search-core README](../rag-search-simple-2/packages/core/README.md).

The useful takeaway is not that Graphify's search is stronger than vector search. It is that a graph-native search tier can be useful without embeddings, model keys, LanceDB setup, background indexing, or provider-specific failure modes. Codegraph is well positioned to build a better version of that tier because it already has richer deterministic graph and symbol data.

## Vectorless Search Opportunity

Graphify's vectorless search is intriguing because it is operationally cheap. It can work immediately after graph extraction, can be checked into a repo as JSON/SQLite artifacts, and can answer relationship-shaped questions by traversing explicit edges rather than ranking opaque vector neighborhoods.

Codegraph can support a similar search layer with stronger ingredients:

- Symbol names, export names, local definitions, import bindings, aliases, and docstrings from the project index.
- File dependency edges, symbol graph edges, re-export chains, and shortest paths from graph builders.
- Semantic chunks and text chunks for lexical/snippet recall.
- SQLite tables for persistent read-only query artifacts.
- Existing impact and review metadata for "what changed" and "what should I inspect/test" queries.

Codegraph already has useful search and query primitives: AST/text `grep`, symbol queries, graph commands, persisted SQLite export, and read-only SQLite queries. The gap is not total absence of search. The gap is a single ranked, explainable `search` workflow that combines those primitives into agent-ready results with snippets, graph context, and follow-up commands.

This would not replace `@lzehrung/rag-search-core`. It should be the zero-setup tier:

- Use vectorless graph search when the question names a file, symbol, package, API, architectural area, dependency path, changed symbol, or test target.
- Use full RAG when the question is phrased in fuzzy natural language, relies on semantic similarity, spans prose/design docs, or needs recall from content that is not structurally connected in the graph.

### Proposed Vectorless Search Shape

Add a deterministic search surface that can run from an in-memory project index or persisted SQLite artifact:

- `codegraph search "<query>" --json`
- `codegraph search "<query>" --mode graph|symbol|text|hybrid`
- `codegraph search "<query>" --from <file-or-symbol> --depth 2`
- `codegraph explain "<symbol-or-file>"`
- `codegraph path <from> <to>` stays as the precise shortest-path command, but `search` can discover likely endpoints first.

The default `hybrid` mode should not mean vector/BM25 hybrid. It should mean deterministic fusion of:

- exact and fuzzy symbol/name matches,
- path and basename matches,
- import/export and dependency-neighborhood expansion,
- graph centrality and community/hotspot signals,
- text/snippet matches from chunked files,
- optional SQL artifact queries when a graph database exists.

### Ranking Model

The ranking should be explainable. Each result should carry `score`, `rankReasons`, and `evidence` fields instead of a single opaque relevance number.

Example result shape:

```json
{
  "kind": "symbol",
  "label": "buildReviewReport",
  "file": "src/review.ts",
  "range": { "start": { "line": 42, "column": 0 }, "end": { "line": 210, "column": 1 } },
  "score": 87.5,
  "rankReasons": [
    "exact symbol token match: review",
    "exported API",
    "2 reverse dependencies",
    "near changed file in current worktree"
  ],
  "neighbors": [
    { "relation": "imports", "target": "src/impact/index.ts" },
    { "relation": "referenced_by", "target": "src/cli.ts" }
  ]
}
```

This gives agents something they can audit and follow up with `deps`, `rdeps`, `goto`, `refs`, or `chunk`.

### Why This Belongs Before Full RAG Integration

Vectorless search is likely a smaller first step than full `rag-search-core` integration:

- It avoids new runtime services, API keys, embeddings, LanceDB schema/version issues, and provider configuration.
- It reuses Codegraph's current index/graph/chunking/SQLite contracts.
- It improves MCP and report workflows immediately.
- It provides a deterministic baseline that full RAG can later augment rather than replace.

The limitation is equally important: vectorless search will miss synonym-heavy or prose-heavy questions where no query terms line up with code symbols, paths, comments, or graph labels. That is the point where `rag-search-core` earns its complexity.

## Feature Comparison

| Area | Codegraph today | Graphify today | Assessment |
| --- | --- | --- | --- |
| Core purpose | Deterministic multi-language code analysis, navigation, PR impact, review artifacts. See [README features](README.md#features). | Folder-to-knowledge-graph product with code, docs, media, reports, query, and agent install hooks. | Different center of gravity. Codegraph is deeper for code; Graphify is broader for knowledge artifacts. |
| RAG/search | Codegraph has AST/text `grep`, symbol and graph query APIs, graph commands, SQLite export, and read-only SQLite queries. It lacks one unified ranked search workflow. Full vector/BM25 RAG exists through sibling `code-navigation` using `@lzehrung/rag-search-core`. | Graph traversal over extracted nodes/edges; explicitly no embeddings/vector DB. | Codegraph has stronger raw ingredients; Graphify has the simpler packaged query UX. |
| Language breadth | First-class source pipeline for JS/TS, Python, PHP, Go, Java, C#, Ruby, Rust, Kotlin, Swift, Zig, C, C++; graph-first docs/templates/styles. See [language parity](docs/language-parity.md). | Claims 25 code languages and has many file extensions in `CODE_EXTENSIONS`; dispatch includes Scala, Lua, PowerShell, Elixir, Objective-C, Julia, Dart, Verilog, Fortran, Pascal/Delphi, SQL, Markdown, and more. See [pyproject dependencies](https://github.com/safishamsi/graphify/blob/5f9ea2b/pyproject.toml#L17-L64), [detect.py extensions](https://github.com/safishamsi/graphify/blob/5f9ea2b/graphify/detect.py#L27-L32), and [extract dispatch](https://github.com/safishamsi/graphify/blob/5f9ea2b/graphify/extract.py#L5446-L5507). | Graphify is wider. Codegraph is more explicit and test-backed about capability tiers. |
| Code semantics | Symbols, imports, exports, goto, refs, chunking, graph, cycles, hotspots, unresolved imports, PR impact. See [README](README.md#features) and [CLI reference](docs/cli.md). | Tree-sitter extracts classes, functions, imports, call graphs, comments; many languages use shared or custom extractors. See [how-it-works](https://github.com/safishamsi/graphify/blob/5f9ea2b/docs/how-it-works.md#L6-L9). | Codegraph has the stronger code-navigation and review contract. |
| PR/diff review | First-class `impact` and `review` commands with changed symbols, impacted files, likely tests, risk, graph deltas, coverage hints. See [CLI impact/review](docs/cli.md#impact-review-and-graph-delta). | No comparable PR impact surface found. | Codegraph is clearly ahead. |
| Reports | `inspect`, graph exports, SQLite, graph viewer, review summaries, but no single repo report artifact by default. | `GRAPH_REPORT.md`, graph JSON, HTML, wiki, SVG, callflow HTML, questions, confidence summaries. | High-ROI gap for Codegraph. |
| MCP | Not first-class in this repo. | MCP server exposes graph query tools. README names `query_graph`, `get_node`, `get_neighbors`, `shortest_path`. See [README](https://github.com/safishamsi/graphify/blob/5f9ea2b/README.md#L234-L242). | High-ROI gap for Codegraph. |
| Persistent graph DB | SQLite export plus read-only SQL access. See [README feature](README.md#features). | NetworkX node-link JSON, global graph JSON, optional Neo4j extra, docs for Docker SQLite MCP. | Codegraph's SQLite artifact is stronger for deterministic tooling, but Graphify has better workflow packaging. |
| Docs/media ingestion | Graph-first Markdown/MDX/RST/AsciiDoc/local links and template/style imports. Narrow by design. | Docs, PDFs, images, Office, Google Workspace, video/audio, URLs/YouTube. Code local; non-code uses assistant/model APIs. See [README](https://github.com/safishamsi/graphify/blob/5f9ea2b/README.md#L147-L154) and [how-it-works](https://github.com/safishamsi/graphify/blob/5f9ea2b/docs/how-it-works.md#L10-L23). | Graphify is ahead on corpus breadth. Codegraph should route this through optional RAG/content adapters, not core AST code. |
| Confidence/provenance | Deterministic diagnostics, parser/native reports, parity tests, changed symbol confidence, candidate-test confidence. | Edges tagged `EXTRACTED`, `INFERRED`, `AMBIGUOUS`. See [README](https://github.com/safishamsi/graphify/blob/5f9ea2b/README.md#L130-L132). | Graphify's confidence tags are simple and useful. Codegraph can adopt a related provenance vocabulary for generated report/query outputs without weakening deterministic surfaces. |
| Watch/update | Incremental build APIs and caches exist; no polished watch/update CLI for artifacts. | `watch`, `update`, `cluster-only`, `check-update`; code changes rebuild graph automatically, non-code changes flag semantic re-extraction. See [README commands](https://github.com/safishamsi/graphify/blob/5f9ea2b/README.md#L339-L343) and [watch implementation](https://github.com/safishamsi/graphify/blob/5f9ea2b/graphify/watch.py). | Medium/high ROI workflow gap. |
| Agent install surface | Bundled Codegraph skill installer for several agents. See [Agent setup](README.md#agent-setup). | Very broad installer/rules surface across Claude, Codex, OpenCode, Cursor, Gemini, Aider, Copilot, and others. | Codegraph has a good base; Graphify is ahead on distribution breadth. |

## Where Codegraph Is Doing Better

### 1. Deterministic semantic depth

Codegraph's core is not just "extract nodes and edges." It supports symbol indexes, go-to-definition, references, public API surface, unresolved import diagnostics, semantic chunks, graph deltas, and diff impact. The README describes this full surface up front, and the CLI reference exposes each surface as a command.

Graphify's code extraction is useful, but its implementation is more extractor-centric. It maps files into NetworkX nodes/edges and then reports/traverses that graph. That is valuable, but it is not the same as Codegraph's navigation and PR-review contract.

### 2. Explicit capability claims

Codegraph's [language parity matrix](docs/language-parity.md#language-coverage-parity-matrix) separates dependency graph, symbol extraction, goto, references, chunking, SFC integration, PR impact, native addon support, and native parity tests. This is the right public posture.

Graphify has broader file extension support, but capability is less explicitly tiered. For example, broad language detection does not necessarily mean equivalent imports, symbols, references, or cross-file resolution.

### 3. PR/review usefulness

Graphify is oriented around repo comprehension. Codegraph is already oriented around action: impact reports, review bundles, candidate tests, graph deltas, and changed-symbol mapping. That is more directly useful for code review and CI workflows.

### 4. Existing real RAG stack nearby

`code-navigation` already combines Codegraph with `@lzehrung/rag-search-core`, including optional codegraph-derived triples for KG linking. See [code-navigation README](../code-review-agent/code-navigation/README.md). This means Codegraph does not need to invent a new retrieval engine or copy Graphify's graph traversal query path.

### 5. SQLite query artifact

Codegraph's SQLite export and read-only SQL command are a stronger deterministic downstream interface than a JSON-only graph artifact. This should become a foundation for MCP/query/report workflows rather than being treated as just another export format.

## Where Graphify Is Doing Better

### 1. "One command to useful artifact"

Graphify's strongest product move is that a user gets `GRAPH_REPORT.md`, graph JSON, HTML/wiki/callflow exports, and a queryable graph artifact from a single workflow. Codegraph can compute much of the same structural data, but it currently asks the user to know which commands to run.

### 2. Query/MCP UX

Graphify exposes a small, memorable graph query surface: query graph, get node, get neighbors, shortest path. Codegraph has more precise primitives, but they are not packaged as an MCP server or "ask the graph" UX.

### 3. Corpus breadth

Graphify handles non-code materials as first-class corpus inputs. This matters for real agent workflows because design docs, PDFs, screenshots, runbooks, and transcripts often explain code behavior better than code alone.

### 4. Watch/update/global graph workflows

Graphify has explicit commands for keeping artifacts fresh and registering a project into a global graph. Codegraph has pieces of this, but not a similarly simple operator story.

## High-ROI Recommendations

### Recommendation 1: Add vectorless graph search first

This is the highest-ROI near-term gap because it combines Graphify's queryability with Codegraph's stronger deterministic artifacts, without introducing vector database or embedding-provider complexity.

Proposed shape:

- `codegraph search "<query>" --json` returns ranked files, symbols, chunks, and graph neighborhoods.
- `codegraph explain "<file-or-symbol>"` returns a compact architecture packet for one node.
- `codegraph search "<query>" --mode graph|symbol|text|hybrid` gives callers control over recall style.
- `codegraph search "<query>" --from <file-or-symbol> --depth 2` starts from a known anchor and expands through graph edges.

Implementation direction:

- Build a shared search library over `ProjectIndex`, dependency graph data, symbol graph data, chunking, and optional SQLite artifacts.
- Return structured, explainable results with rank reasons and follow-up command suggestions.
- Keep the first version local-only, deterministic, and free of new services.
- Use this same library for CLI, MCP, and report suggested-question workflows.

Acceptance criteria:

- Works after `buildProjectIndex()` without requiring a persisted artifact.
- Also works from a SQLite export when available.
- Includes exact/fuzzy path and symbol matching, graph-neighborhood expansion, and chunk/text snippets.
- Documents that this is deterministic graph search, not vector or embedding search.
- Updates [README](README.md), [docs/cli.md](docs/cli.md), [docs/library-api.md](docs/library-api.md), and [codegraph-skill/codegraph/SKILL.md](codegraph-skill/codegraph/SKILL.md).

### Recommendation 2: Add an optional Codegraph RAG/search layer backed by rag-search-core

This remains high ROI, but it should build on the deterministic search tier instead of being the only answer to queryability.

Proposed shape:

- `codegraph rag index <roots...>` builds or updates a LanceDB-backed RAG index from Codegraph semantic chunks.
- `codegraph rag search "<query>" --json` returns ranked chunks with path, line spans, symbol metadata, graph-neighbor hints, scores, and source reasons.
- `codegraph rag context "<query>" --budget 12000` returns an agent-ready context packet.
- `codegraph rag update --base HEAD --head WORKTREE` incrementally refreshes changed files.

Implementation direction:

- Use `chunkFile`, `chunkSFCFile`, and `chunkTextFile` as the chunk source.
- Use `ingestPreparedMany()` from `@lzehrung/rag-search-core`.
- Attach Codegraph-derived triples from imports, dependencies, exported symbols, symbol-defined-in, and optionally callsites.
- Preserve deterministic metadata: repo path, line span, symbol id, symbol kind, language id, content hash, and graph artifact id.

Acceptance criteria:

- Retrieval works without changing Codegraph's existing graph/index output contracts.
- It can run with `EMBED_OFFLINE=1` or equivalent test mode in CI.
- It documents vector/BM25/KG behavior accurately and does not call it "GraphRAG" unless KG fusion is enabled.
- It updates [README](README.md), [docs/cli.md](docs/cli.md), [docs/library-api.md](docs/library-api.md), and [codegraph-skill/codegraph/SKILL.md](codegraph-skill/codegraph/SKILL.md).

### Recommendation 3: Generate `CODEGRAPH_REPORT.md`

Graphify's report artifact is simple but effective. Codegraph should ship a deterministic equivalent.

Proposed content:

- Repo summary: files by language, native/runtime diagnostics, unresolved imports, cycles.
- Hotspots and public API surface.
- Top dependency clusters and boundary concerns.
- Suggested follow-up commands.
- If a git range is provided: changed symbols, impacted files, candidate tests, risk summary.
- If RAG is enabled: top retrievable domains and query examples.

This should be deterministic and cheap. It can optionally include model-generated commentary later, but the first version should avoid LLM dependency.

### Recommendation 4: Add an MCP server over Codegraph artifacts

Graphify's MCP server is a good idea, but Codegraph can expose stronger tools:

- `inspect_repo`
- `query_graph`
- `get_node`
- `get_neighbors`
- `shortest_path`
- `goto_definition`
- `find_references`
- `search_symbols`
- `search_rag`
- `impact`
- `candidate_tests`
- `sql_readonly`

The server should prefer existing SQLite/index artifacts when present, and build lazily only when requested. It should keep read-only guarantees for SQL and file access.

SQL is no longer listed as a Graphify gap. Codegraph now treats `.sql` files as part of language support, including schema objects, graph edges, navigation, references, SQLite persistence, and documented parity/scenario coverage. Remaining SQL work should be tracked as accuracy or semantic-navigation improvements, not as missing extraction.

### Recommendation 5: Expand language support in tiers

Graphify's language breadth is attractive, but Codegraph should not collapse "file detected" into "semantic parity."

Recommended tiering:

- Tier 1, graph/chunk only: Scala, Lua, PowerShell, Elixir, Objective-C, Julia, Dart, Verilog/SystemVerilog, Fortran, Pascal/Delphi.
- Tier 2, symbols/imports: add stable language definitions and tests where Tree-sitter grammar quality is good.
- Tier 3, full navigation: goto/refs/PR impact only after cross-file fixtures prove resolution behavior.

This preserves Codegraph's stronger correctness posture while closing the perceived language gap.

### Recommendation 6: Add artifact update/watch/global workflows

Proposed shape:

- `codegraph artifact build --report --sqlite --json --rag`
- `codegraph artifact update --base HEAD --head WORKTREE`
- `codegraph watch . --artifact codegraph-out`
- `codegraph global add codegraph-out/codegraph.sqlite --as myrepo`

This should be a workflow layer over existing graph/index/RAG commands, not a new storage model.

### Recommendation 7: Use confidence/provenance labels in generated outputs

Graphify's `EXTRACTED` / `INFERRED` / `AMBIGUOUS` vocabulary is useful for humans. Codegraph should adopt a compatible but stricter model for report and MCP output:

- `EXTRACTED`: direct parser/index/diff evidence.
- `RESOLVED`: deterministic resolver evidence across files/packages.
- `HEURISTIC`: ranking, likely tests, graph-neighborhood inference.
- `MODEL_INFERRED`: only if an LLM was used.
- `AMBIGUOUS`: multiple plausible targets or incomplete evidence.

This keeps deterministic Codegraph outputs honest while making generated reports easier to read.

## Lower-ROI Or Riskier Ideas

- Copying Graphify's LLM semantic extraction pipeline into Codegraph core. This would blur Codegraph's deterministic contract and duplicate capabilities better handled by `rag-search-core` or a separate optional package.
- Treating every Graphify-supported extension as a first-class Codegraph language immediately. That would weaken the current parity standard.
- Building a new vector store or bespoke RAG engine. The local `@lzehrung/rag-search-core` package already provides this.
- Making Codegraph's core depend on media/PDF/office/video parsing. Keep this optional and adapter-driven.

## Suggested Implementation Plan

### Phase 1: Vectorless graph search

Add `codegraph search` and `codegraph explain` over existing index, graph, chunking, and optional SQLite artifacts.

Why first: it captures the most intriguing part of Graphify's query UX while staying deterministic and low complexity. It also becomes the shared search layer for report and MCP workflows.

### Phase 2: Report artifact

Add `codegraph report <roots...> --output CODEGRAPH_REPORT.md` using only existing deterministic data.

Why second: low dependency risk, high product visibility, and it exercises how Codegraph should present provenance, hotspots, cycles, unresolved imports, API surface, suggested commands, and vectorless search results.

### Phase 3: MCP server

Add `codegraph serve --stdio --artifact <path>` with graph/index/SQLite-backed tools. Start read-only.

Why third: it turns existing Codegraph precision into agent-accessible repeated tools, matching one of Graphify's strongest workflow ideas.

### Phase 4: RAG integration

Add an optional RAG package or command group using `@lzehrung/rag-search-core` and Codegraph chunks/triples.

Why fourth: high upside, but it needs careful package-boundary and dependency decisions so Codegraph's lightweight deterministic core stays clean.

### Phase 5: Language tiers

Broaden language support in documented tiers.

Why fifth: these expand competitive surface area but should follow the established language parity discipline.

## Bottom Line

Graphify is ahead on packaging the graph as a user-facing and agent-facing artifact. Codegraph is ahead on deterministic code semantics, review workflows, native runtime integration, and compatibility with a real hybrid RAG library.

The best move is to use Graphify as product inspiration, not as architecture to clone. The refined priority is to build vectorless graph search first, then layer report and MCP workflows on top of it, and then add optional full RAG for questions that need semantic/vector recall. Codegraph should add unified search, report, MCP, artifact, RAG, and tiered language workflows while preserving its current strength: accurate, test-backed code intelligence that downstream agents can trust.
