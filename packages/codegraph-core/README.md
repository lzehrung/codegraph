# `@lzehrung/codegraph-core`

Pure library surface for indexing, graphs, impact analysis, and agent-shaped helpers.

```bash
npm install @lzehrung/codegraph-core
```

```ts
import { buildProjectIndex, resolveSymbolTarget } from "@lzehrung/codegraph-core";

const index = await buildProjectIndex(process.cwd());
const target = resolveSymbolTarget(index, "src/service.ts::start");
if (target.status !== "exact") throw new Error(`Target did not resolve: ${target.input}`);

console.log(target.target.handle, target.target.definition.range.start);
```

CLI, MCP server, installer, and graph-viewer assets remain in `@lzehrung/codegraph`.
See [`docs/library-api.md`](../../docs/library-api.md).
