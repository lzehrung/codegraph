---
section: Changed
---

`codegraph symbols`, the MCP `workspace_symbols` tool, and the `queryWorkspaceSymbols` and `workspaceSymbols` library functions derive each symbol's display path, exported name, and lowercase names once per index instead of on every query, and build matches only for the results they return; results are unchanged. On a 3,487-file Python project a repeated query took about 11 ms of CPU instead of 585 ms, and the first query of an index 282 ms instead of 1,031 ms. In one session, 200 queries raised peak RSS by 15 MiB instead of 766 MiB, because a query no longer allocates an object and several strings for every indexed symbol. Each call now returns new match objects, so changing a returned import alias no longer changes later answers.
