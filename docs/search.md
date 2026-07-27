# Vectorless Search

Codegraph search is deterministic lexical retrieval over a parsed symbol index and repository graph. It does not generate embeddings, call an embedding model, or require a vector database.

## Why it feels semantic

The ranking is lexical, but the things being ranked are structural:

| Layer      | What Codegraph knows                                                        |
| ---------- | --------------------------------------------------------------------------- |
| Syntax     | Symbols, definitions, exports, docstrings, and source ranges                |
| Repository | Resolved imports, dependencies, reverse dependencies, and graph distance    |
| Text       | Normalized identifiers, paths, prose chunks, SQL objects, and exact phrases |

A result for `buildReviewReport` is therefore more than a matching string. Codegraph knows that it is a symbol in `src/review.ts`, where it is defined, which files reference or depend on it, and which follow-up commands can inspect it.

Here, "semantic" means syntax- and symbol-aware analysis from the repository. It does not mean embedding similarity.

## How ranking works

Search follows a compact pipeline:

1. Normalize the query by splitting camel case, lowercasing, removing punctuation, and deduplicating tokens.
2. Gather candidates from the selected surfaces: symbols, paths, text chunks, SQL objects, or graph nodes.
3. Score lexical evidence. Exact words and phrases beat ordered-token and substring matches.
4. Apply structural weights. Symbol-name matches outrank incidental prose; exports and nearby graph nodes can receive additional weight.
5. Sort deterministically by score, then stable label and file-path tie breakers.

Hybrid mode is code-first by default. A direct implementation or symbol match normally outranks documentation, while `--mode text` intentionally favors prose-heavy retrieval.

Every result explains its ranking with:

- a stable handle and source range
- provenance and analysis mode
- rank reasons and supporting evidence
- graph or symbol neighbors
- copyable follow-up commands
- explicit limits and omission counts

This makes relevance inspectable instead of hiding it behind vector distance.

## Search modes

| Mode     | Use it for                                               |
| -------- | -------------------------------------------------------- |
| `hybrid` | Default search across symbols, paths, and text           |
| `symbol` | Definitions and identifier-oriented queries              |
| `path`   | File paths and directory components                      |
| `text`   | Documentation and prose-heavy queries                    |
| `graph`  | Matches near a known file, symbol, SQL object, or handle |
| `sql`    | Indexed SQL objects and relations                        |

Examples:

```bash
codegraph search "validate user" --json
codegraph search "public users" --mode sql --json
codegraph search "handle login" --mode graph --from src/auth.ts --depth 1 --json
```

Graph mode performs a bounded traversal from `--from` and boosts closer matches. It answers "which matching things are structurally near this anchor?" rather than only "which files contain these words?"

## Search versus explore

`search` finds and ranks anchors. Use it when the next step needs a file, symbol, SQL object, or stable handle.

`explore` orchestrates search with additional repository evidence:

- bounded source packets
- dependency paths
- reverse-dependency blast radius
- candidate tests
- next commands
- limits and omission counts

Use `explore` for a concrete repository question and `search` when you only need the best starting targets.

```bash
codegraph explore "how does auth reach the database?" --root .
codegraph search "validate user" --json
```

## Strengths and limits

Vectorless search is local, deterministic, explainable, and does not require embedding regeneration when the repository changes. Exact identifiers, source locations, and graph relationships remain first-class evidence rather than metadata attached after retrieval.

The tradeoff is conceptual recall. If a query and implementation share no words, docstrings, paths, SQL names, or graph bridge, Codegraph may miss a synonym that embedding search would connect. Use repository terminology, add a structural `--from` anchor, or start with `explore` when the question needs several retrieval steps.
