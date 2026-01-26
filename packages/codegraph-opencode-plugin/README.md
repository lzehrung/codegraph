# OpenCode Plugin for Codegraph

This package integrates [codegraph](https://github.com/lzehrung/codegraph) capabilities into [OpenCode](https://opencode.ai) agents.

## Installation

This is a custom tool plugin for OpenCode. You can install it by configuring it in your OpenCode settings or placing the built file in your tools directory.

**File Location:**
- Project-specific: `.opencode/tools/codegraph.ts`
- Global: `~/.config/opencode/tools/codegraph.ts`

You can also import this package directly if you are building a custom agent environment that supports the OpenCode tool interface.

```bash
npm install @lzehrung/codegraph-opencode-plugin
```

## Features

This plugin exposes the following tools to the agent:

*   **graph**: Get the dependency graph of the project.
*   **definition**: Go to definition of a symbol.
*   **references**: Find references to a symbol.
*   **overview**: Get a high-level overview of a file (imports and definitions).
*   **impact**: Analyze impact of changes (compare git revisions).
*   **grep**: Search for symbols or patterns using Tree-sitter query or regex.

## Usage in System Prompt

To help the agent use these tools effectively, add the following to your system prompt:

> You have access to `codegraph` tools.
> *   Use `codegraph_graph` to understand the project structure and file dependencies.
> *   Use `codegraph_definition` to find where functions/classes are defined.
> *   Use `codegraph_references` to find usages before renaming or refactoring.
> *   Use `codegraph_impact` to see what might break before you edit code.

## Architecture

This plugin is designed to be robust:
1.  It attempts to use the `@lzehrung/codegraph` library programmatically if available in the environment.
2.  If the library is not found, it falls back to executing `npx codegraph` via the CLI.

This ensures it works in ephemeral environments where the full package tree might not be installed, as long as `npx` is available.
