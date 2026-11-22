---
section: Fixed
---

MCP watchers keep watching through startup warmup and begin their full idle interval afterward. Server lifecycle and installer operations hold an operating-system file lock for their whole duration, so two commands in the same environment never overlap, and a crashed or killed holder (including a forcibly terminated MCP discovery probe) releases it at once. Leases are renewed while held: a holder in another environment (for example Windows and WSL sharing a project), with a different state directory, or from an older Codegraph version is recovered after its lease expires, and the busy message names the lock file, the holder, and the remedy. Lock anchors live in the per-user Codegraph state directory, and read-only filesystems fall back to lease-only coordination.
