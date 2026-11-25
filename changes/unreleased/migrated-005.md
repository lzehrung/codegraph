---
section: Fixed
---

MCP watchers keep watching through startup warmup and begin their full idle interval afterward. Server lifecycle and installer commands hold an operating-system file lock while they run, so commands in one environment never overlap and a killed holder, such as a forcibly terminated MCP discovery probe, releases it at once; holders in another environment (such as Windows and WSL sharing a project), with another state directory, or from an older version are recovered after their renewed lease expires. Busy errors name the lock file, the holder, and the remedy, and lock anchors live in the per-user Codegraph state directory, with lease-only coordination where an anchor cannot be opened.
