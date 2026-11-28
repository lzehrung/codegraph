---
section: Changed
---

The disk search sidecar behind `codegraph search`, `codegraph explore`, and the MCP `search` and `explore` tools stores each file's chunk text as one compressed block instead of compressing every chunk separately, and `text` and `hybrid` searches decompress chunk text only for the snippets of the results they return, not for every candidate; results are unchanged. Preparing the sidecar for a 3,487-file Python project took 8.2 s of CPU instead of 24.8 s and peaked at 0.5 GiB of RSS instead of 3.1 GiB (a 2,505-file C# project: 5.3 s instead of 36.1 s, and 0.4 GiB instead of 5.3 GiB). A search on those projects decoded the text of 18 to 45 chunks on average instead of 1,600 to 2,100 and used about a third less CPU. The sidecar schema is now version 5, so a sidecar written by an earlier version is emptied on first use and rebuilt from source once.
