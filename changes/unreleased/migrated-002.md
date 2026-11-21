---
section: Security
---

The production audit accepts `picomatch` advisory [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) until 2026-12-17. No patched `picomatch` release exists. Glob patterns from CLI flags, MCP arguments, and `codegraph.config.json` (which an indexed repository can supply) reach it directly and through `tinyglobby`, so a crafted pattern can make one index run or query spend excessive CPU. Tracked in [#582](https://github.com/lzehrung/codegraph/issues/582).
