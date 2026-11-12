# Real-code accuracy benchmark

`npm run accuracy` compares Codegraph with a compiler or language-service oracle on pinned open-source repositories. It reports wrong definitions, misses, reference precision and recall, unsupported `complete` coverage claims, and detailed-graph call edges.

## Run

```sh
npm run accuracy -- --language ts
npm run accuracy -- --language csharp
npm run accuracy -- --language all --seed 1 --max-sites 400 --max-declarations 80
npm run accuracy -- --repo zod --corpus-dir /tmp/accuracy-corpus --output .accuracy --json
```

- Needs Node.js 22.16+, Git, and network access for the first clone. C# also needs the .NET 10 SDK; the Roslyn oracle restores its own pinned packages on first run.
- `--language ts|csharp|all` (default `all`), `--repo <id>`, `--seed` (default `1`), `--max-sites` (default `400`), `--max-declarations` (default `80`).
- `--corpus-dir` defaults to `<os.tmpdir()>/codegraph-accuracy/corpus`. Clones are pinned to the manifest commit; a reused clone must already be at that commit.
- `--output` defaults to `.accuracy/` (gitignored). `--json` prints the aggregate summary to stdout.
- [`scripts/accuracy/corpus.json`](../../scripts/accuracy/corpus.json) pins the repositories (Zod, Hono, Spectre.Console, Humanizer) and their include and exclude globs.

## How it scores

The harness indexes a repository, sends the indexed files for one language to the oracle, and queries the built Codegraph API at the sites the oracle samples. Sampling is deterministic: candidates are sorted by file, line, and column, then shuffled with mulberry32 from the seed.

- **Correct, wrong, missed:** `goToDefinition` matches an oracle definition by file and line, returns another project target, or finds nothing for a site the oracle resolves. Any overload or partial declaration counts as a match.
- **Constructors:** a constructor site accepts the constructed type's declaration names (including merged or partial parts) as well as an explicit constructor, for both definitions and `instantiates` edges. TypeScript expands only class symbols; constructor-valued parameters and properties retain their ordinary language-service definitions.
- **External OK:** the oracle resolves outside the project and Codegraph returns no project target. **Excluded:** the oracle cannot resolve the site.
- **Refs P / R:** `findReferences` precision and recall by exact position. The declaration itself and related declarations (overloads, merged or partial declarations, C# constructors) are excluded from both sides. **Overclaims:** Codegraph reports `complete` coverage with recall below 1.
- **Edges:** whether `buildSymbolGraphDetailed` has a `calls` or `instantiates` edge from the enclosing function to the oracle target at sampled call sites.

Each run writes `<repo>.request.json`, `<repo>.oracle.json`, `<repo>.json` (every sampled answer), and `summary.md` (rates per language, repository, and syntax form, plus the first 20 wrong answers per repository).

## Limits

- The oracle sees only the indexed files plus the language standard library: no package restore, code generation, or build configuration. Sites that need missing packages are excluded, not credited.
- The TypeScript oracle uses the root `tsconfig.json` compiler options when present and does not type-check whole programs. The C# oracle compiles all indexed files as one project.
- A sample is not a proof of whole-repository accuracy. Compare runs only with the same seed, limits, pins, and oracle versions.
- The C# oracle test runs only with `CODEGRAPH_ACCURACY_ORACLES=1` because it needs .NET and a package restore.
