# Explore facade

## Goal

Add one high-level query surface that returns enough structured context for an agent or human to start work without manually sequencing `orient`, `search`, `packet_get`, `refs`, `deps`, and `path`.

Commands/tools:

```bash
codegraph explore "how does auth reach db?" --root .
codegraph explore "src/auth.ts" --json
```

MCP tool:

```text
explore
```

## Design

Implement `explore` as a facade over existing primitives, not as a second search engine.

Pipeline:

1. Parse query.
2. Detect explicit file paths or handles.
3. Run `searchCodegraph()` for semantic anchors.
4. Fetch bounded packets for top anchors.
5. Add graph paths when query has two recognizable anchors or phrases like "reach", "flow", "call", "through".
6. Add reverse dependencies/blast-radius for primary anchors.
7. Add candidate tests when git context is available or a changed file is referenced.
8. Return omissions and follow-up commands.

## Output shape

JSON:

```ts
type ExploreResponse = {
  schemaVersion: 1;
  query: string;
  analysis: AnalysisSummary;
  summary: string[];
  anchors: SearchResult[];
  packets: PacketSummary[];
  paths: DependencyPathSummary[];
  blastRadius: BlastRadiusSummary[];
  candidateTests: string[];
  followUps: string[];
  limits: Record<string, number>;
  omittedCounts: Record<string, number>;
};
```

Pretty output should be concise:

```text
Summary
Anchors
Relevant source
Paths
Blast radius
Candidate tests
Follow-ups
Limits
```

## Limits

Defaults must be bounded:

- max anchors: 5
- max packets: 3
- max source lines per packet: existing packet defaults
- max paths: 3
- max reverse dependencies: 20

Expose flags:

```bash
--limit <n>
--max-packets <n>
--max-paths <n>
--no-source
--json
--pretty
```

## MCP behavior

Keep existing MCP primitives. Add `explore` as the recommended first tool for broad questions. Do not hide existing tools.

## Files likely touched

- `src/agent/search.ts`
- `src/agent/packet.ts`
- new `src/agent/explore.ts`
- `src/mcp/tools.ts`
- `src/mcp/server.ts`
- `src/cli/help.ts`
- `src/cli/options.ts`
- new `src/cli/explore.ts`
- `docs/cli.md`
- `docs/mcp.md`
- `docs/agent-workflows.md`
- `codegraph-skill/codegraph/SKILL.md`
- tests under new `tests/agent-explore.test.ts`

## Tests

- file-path query returns that file packet and reverse dependencies.
- symbol query returns matching anchor and packet.
- flow query between two files includes dependency path when one exists.
- no-result query returns useful next steps, not an empty crash.
- JSON schema is stable and bounded.
- MCP tool validates flat schema inputs.

## Acceptance

- `explore` answers broad repo questions in one call using existing packet/search semantics.
- Existing search/explain/packet behavior remains unchanged.
- Output is bounded, provenance-aware, and includes follow-ups.

## Review pass

Checked scope: this plan keeps `explore` as an orchestration layer. It improves agent ergonomics without duplicating search, packet, or graph traversal logic.
