# Opencode Integration for Codegraph

This document describes how to integrate `@lzehrung/codegraph` with the Opencode agent.

## Benefits for Opencode

Integrating `codegraph` provides the Opencode agent with:

1.  **Semantic Code Navigation**: Go to definition and find references across languages (TS, Python, Go, etc.) without needing heavy LSP setups.
2.  **Robustness**: Works even when code is broken or dependencies are missing, which is common during refactoring or bug fixing.
3.  **Fast Cold Start**: Indexes a repository in seconds, making it ideal for ephemeral agent sessions.
4.  **Graph-Based Understanding**: Helps the agent understand dependency relationships and file structure.
5.  **Impact Analysis**: Allows the agent to see what files are affected by a change (e.g., from a PR diff).

## Tool Definitions

The following tools are exported for agent use from `@lzehrung/codegraph`:

*   `tool_listProjectFiles(root: string)`: List all source files in the project.
*   `tool_getGraph(root: string)`: Get the dependency graph of the project (files and edges).
*   `tool_goToDefinition(root: string, file: string, line: number, column: number)`: Find the definition of the symbol at the given location.
*   `tool_findReferences(root: string, file: string, line: number, column: number)`: Find all references to the symbol at the given location.
*   `tool_findSymbol(root: string, query: string)`: Search for a symbol by name.
*   `tool_getFileOverview(root: string, filePath: string)`: Get a markdown summary of a file's imports and definitions.
*   `tool_impactJSON(root: string, options: ImpactOptions)`: Analyze the impact of changes (git diff or raw text).

## System Prompt Addition

To enable these features, add the following to the Opencode agent's system prompt or tool configuration:

```typescript
// Tool Interface Definitions

type CodegraphTools = {
  /**
   * List all files in the project.
   */
  listProjectFiles(): Promise<{
    status: "ok" | "error";
    files?: string[];
  }>;

  /**
   * Go to the definition of the symbol at the specified location.
   * Use this to navigate to where a function, class, or variable is defined.
   */
  goToDefinition(file: string, line: number, column: number): Promise<{
    status: "ok" | "error" | "not_found";
    definition?: { file: string; range: { start: { line: number; column: number } } };
    reason?: string;
  }>;

  /**
   * Find all references to the symbol at the specified location.
   * Use this to find all usages of a function, class, or variable.
   */
  findReferences(file: string, line: number, column: number): Promise<{
    status: "ok" | "error" | "not_found";
    references?: Array<{ file: string; range: { start: { line: number; column: number } } }>;
    reason?: string;
  }>;

  /**
   * Get the file dependency graph.
   * Use this to understand the structure of the project and file relationships.
   */
  getGraph(): Promise<{
    status: "ok" | "error";
    graph?: { nodes: string[]; edges: Array<{ from: string; to: string }> };
  }>;

  /**
   * Search for a symbol by name.
   * Use this when you know the name of a symbol but not its location.
   */
  findSymbol(query: string): Promise<Array<{ name: string; kind: string; file: string; line: number }>>;

  /**
   * Get a high-level overview of a file.
   * Use this to quickly understand what imports and definitions are in a file.
   */
  getFileOverview(filePath: string): Promise<string>;
};
```

### Usage Instructions

"You have access to `codegraph` tools for code navigation.
- When you see a function call and need to know what it does, use `goToDefinition`.
- When you are renaming or changing a function, use `findReferences` to find all call sites.
- Before reading a large file, use `getFileOverview` to get a summary.
- If you are lost or need to find a specific class/function, use `findSymbol`.
- To understand how files depend on each other, use `getGraph`."
