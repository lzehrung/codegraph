---
section: Fixed
---

The MCP HTTP server now requires `@hono/node-server` 2.1.6 or later, which fixes a process crash on a reset socket during a WebSocket upgrade (GHSA-qv5m-9pm6-hqp3) and backslash path parsing that could bypass path-based access control at a reverse proxy (GHSA-jpvv-r467-5p4w).
