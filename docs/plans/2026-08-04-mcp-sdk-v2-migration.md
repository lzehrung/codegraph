# MCP TypeScript SDK v2 migration

**Status:** Planned

## Goal

Move Codegraph from the legacy monolithic `@modelcontextprotocol/sdk` v1 package to the official stable v2 server packages while preserving existing MCP clients and public CLI behavior. Serve the current 2026-07-28 protocol over stdio and Streamable HTTP, retain 2025-era compatibility, reduce production dependencies, and keep one shared Codegraph analysis session per server process.

Success is protocol interoperability, not merely compiling against renamed imports.

## Decisions and invariants

- Keep the official SDK. Hand-rolled JSON-RPC, version negotiation, transports, or schema validation would make Codegraph responsible for evolving protocol compliance.
- Use `@modelcontextprotocol/server` plus the thin `@modelcontextprotocol/node` adapter. Add `@modelcontextprotocol/client` only as a dev dependency and interoperability test oracle.
- Use the v2 serving entries. `server.connect(new StdioServerTransport())` and a renamed v1 HTTP transport still serve only the 2025 era.
- Keep the low-level `Server` tool handlers. Codegraph already owns one canonical `MCP_TOOLS` JSON Schema catalog and one `callMcpTool` dispatcher; converting every tool to `McpServer.registerTool` would duplicate schemas and add churn.
- Preserve the current sessionful, JSON-response legacy HTTP path during this migration. Route modern requests to `createMcpHandler(..., { legacy: "reject" })` with the SDK's `isLegacyRequest` classifier. Replacing legacy HTTP with v2's stateless fallback would silently remove session IDs and can change JSON responses to SSE; that is a separate compatibility decision.
- Preserve one warmed `CodegraphMcpHandlers`/`AgentSession` per process. Modern HTTP protocol instances may be per request, but repository analysis state must remain shared.
- Preserve the public endpoint, flags, tool names, schemas, read-only defaults, body limit, Host validation, and installed-version warnings.
- Add Origin validation before either HTTP protocol path. Requests without `Origin` remain valid for non-browser MCP clients; malformed, opaque (`Origin: null`), or unapproved browser origins fail with 403.
- Do not add authentication in this migration. Non-loopback `--host` remains an explicitly exposed, unauthenticated service and must be documented as trusted-network-only.
- No version bump, release tag, compatibility shim outside the SDK's supported legacy mode, or unrelated refactor.

Official references:

- <https://github.com/modelcontextprotocol/typescript-sdk#readme>
- <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md>
- <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md>

## Implementation sequence

### 1. Replace dependencies deliberately

Files: `package.json`, `package-lock.json`.

1. Replace runtime `@modelcontextprotocol/sdk` with compatible `^2.0.0` ranges for:
   - `@modelcontextprotocol/server`
   - `@modelcontextprotocol/node`
2. Add `@modelcontextprotocol/client` `^2.0.0` to `devDependencies` for black-box modern-protocol tests. It must not enter production dependencies or runtime source. `isInitializeRequest` is publicly re-exported by `@modelcontextprotocol/server`; do not add `@modelcontextprotocol/core`.
3. Remove MCP-v1-only overrides, including `fast-uri`; remove the entire `overrides` object if nothing unrelated remains. Do not pin Hono, `@hono/node-server`, Express, `body-parser`, or `ip-address` at the root when the resolved compatible versions pass the production audit.
4. Regenerate the lockfile with normal `npm install`, then verify a clean `npm ci --ignore-scripts --dry-run`.
5. Do not run the repository-wide MCP codemod: runtime imports exist only in `src/mcp/server.ts` and `src/mcp/tools.ts`, so targeted edits are smaller and reviewable. Use the official migration guide as the API source of truth.

Expected production result: no v1 SDK, Express, `express-rate-limit`, `body-parser`, `ip-address`, Ajv, or `fast-uri` through MCP. `@hono/node-server` may remain under the official Node adapter; do not suppress a harmless Hono peer warning with an unrelated runtime dependency.

### 2. Build one transport-neutral protocol factory

Files: `src/mcp/server.ts`, `src/mcp/tools.ts`.

1. Import `Server`, `Tool`, `CallToolResult`, and `isInitializeRequest` from the v2 public server package. Never import `@modelcontextprotocol/core-internal`.
2. Change `createCodegraphMcpProtocolServer` to return the v2 low-level `Server`:
   - construct it with `{ name: "codegraph", version: runtimeIdentity.runningVersion }`;
   - advertise `{ tools: {} }` exactly, without claiming `listChanged`;
   - register method-string handlers for `"tools/list"` and `"tools/call"`;
   - retain the installed-version check, `MCP_TOOLS`, `callMcpTool`, `toToolResult`, and current error behavior.
3. Remove v1 schema-first `setRequestHandler` calls and the `McpServer.server` wrapper. Remove the `as Transport` cast; v2 transport declarations satisfy the contract directly.
4. Keep factory construction cheap and side-effect-free. `serveStdio` can construct a probe instance and then a second legacy instance during negotiation fallback; warming and `AgentSession` creation must remain outside the protocol factory.
5. Keep all protocol logging on stderr through the existing diagnostic path. Never write diagnostics to stdout because stdout is the stdio JSON-RPC channel.

### 3. Enable modern and legacy stdio correctly

File: `src/mcp/server.ts`.

1. Replace direct `StdioServerTransport` connection with `serveStdio(() => createCodegraphMcpProtocolServer(...))` from `@modelcontextprotocol/server/stdio`.
2. Leave legacy serving enabled, so existing installed clients using the 2025 `initialize` handshake continue to work.
3. Pass an `onerror` reporter that writes a concise Codegraph-prefixed message to stderr and never changes protocol responses.
4. Preserve lazy startup and explicit warmup: create/warm handlers once before invoking `serveStdio`; every protocol instance closes over the same handlers.

### 4. Add the modern HTTP path without breaking legacy HTTP

Files: `src/mcp/server.ts`, `src/mcp/http.ts`.

1. Rename the v1 HTTP transport import to v2 `NodeStreamableHTTPServerTransport`. Keep the existing session map, `enableJsonResponse: true`, UUID session IDs, GET/DELETE handling, and session close behavior for legacy requests.
2. Create one modern handler when `startCodegraphMcpHttpServer` starts:
   - `createMcpHandler(factory, { legacy: "reject", onerror })` from `@modelcontextprotocol/server`;
   - wrap it once with `toNodeHandler` from `@modelcontextprotocol/node`;
   - use the same transport-neutral protocol factory and shared Codegraph handlers.
3. Keep boundary checks in this order: exact `/mcp` path, allowed Host, allowed Origin, bounded body read/JSON parse, then protocol classification and dispatch. Invalid requests must not construct a protocol server or load the project index.
4. Convert the already parsed Node request with `toWebRequest`, and call the SDK's `isLegacyRequest(request, parsedBody)`. Route only SDK-classified legacy traffic to the preserved sessionful path; route every modern claim and every malformed modern claim to the strict modern handler so the SDK emits the required modern error.
5. Pass the parsed body to `toNodeHandler` so the Node stream is never read twice. Do not reproduce envelope, standard-header, protocol-version, or JSON-RPC validation in Codegraph.
6. Close both subsystems deterministically: returned `close()` closes the modern handler, every legacy session, and the Node HTTP server. The server `close` event must also release both protocol paths without unhandled rejections.
7. Keep the modern handler's default response mode. It returns JSON when no related message is emitted and can upgrade to SSE when future protocol features require it; forcing `responseMode: "json"` would drop progress/log notifications and emit a warning.

### 5. Add Origin validation without weakening Host validation

Files: `src/mcp/http.ts`, `src/mcp/server.ts`, `tests/mcp-server.test.ts`.

1. Preserve the existing port-aware Host rules and wildcard-bind/loopback protections; the SDK entry performs neither Host nor Origin validation itself.
2. Derive allowed Origin hostnames from the same raw configured bind candidates used for Host rules, before formatting ports. Include equivalent loopback names for loopback binds and local interface names/addresses for wildcard binds; do not use `*`.
3. Use the v2 Node `originValidation` guard rather than writing URL parsing and opaque-origin behavior locally.
4. Apply Host validation first, then Origin validation. A missing Origin passes; a present unapproved, malformed, or `null` Origin receives 403 before body parsing or tool dispatch.

## Test plan

### Focused protocol tests

Add `tests/mcp-protocol-v2.test.ts` so version-negotiation coverage is separate from handler behavior.

- **Modern HTTP interoperability:** start the real HTTP server; connect with the official v2 `Client` and `StreamableHTTPClientTransport` using automatic negotiation; assert `getProtocolEra()` is `"modern"`, server identity reports the running Codegraph version, `tools/list` contains representative tools, and a real `tools/call` returns expected repository data.
- **Modern stdio interoperability:** launch `node ./dist/cli.js mcp serve --root <fixture> --stdio --native off --cache off` through `StdioClientTransport` from `@modelcontextprotocol/client/stdio` with automatic negotiation; assert modern era, server identity, tool listing, and one real tool call; close the client and require the child to exit cleanly. This is the smoke test proving `serveStdio`, not merely renamed imports, is active.
- Use bounded timeouts and `finally` cleanup for clients, child processes, HTTP servers, and temporary roots. Tests must be Windows-safe and must not depend on shell invocation.

### Legacy and HTTP-boundary regression coverage

Update or retain `tests/mcp-server.test.ts`, `tests/mcp-workspace-symbols.test.ts`, and `scripts/certification/package-smoke-lib.mjs`.

- Keep the raw 2025-11-25 stdio package smoke unchanged in intent: initialize, `notifications/initialized`, list tools, call `search`, and verify the packaged server version. This proves backward compatibility independently of the v2 client.
- Keep legacy HTTP session assertions: initialize returns a session ID; subsequent list/call requests reuse it; missing or unknown session IDs retain the current error contract; GET/DELETE lifecycle remains functional; JSON response behavior remains unchanged.
- Retain tool-schema limit and invalid-argument tests across the protocol boundary.
- Retain path, Host, body-size, malformed-JSON, wrong-path, and unsupported-method coverage.
- Add Origin cases: no Origin accepted, matching loopback Origin accepted, hostile hostname rejected, malformed Origin rejected, `Origin: null` rejected, and wildcard bind accepts the tested local origin while still rejecting an external one.
- Assert rejected Host/Origin/oversized/malformed requests do not call the tool handler or load the project session.
- Add one modern malformed-claim/header-mismatch request only if needed to prove routing reaches the strict modern handler; assert the SDK-defined status/code category, not incidental prose.

Do not duplicate the SDK's own unit tests for every negotiation error or wire codec. Codegraph tests should prove its routing, shared-session integration, security gates, packaging, and legacy/modern interoperability.

### Dependency, package, and runtime verification

Run in this order:

1. `npm ci --ignore-scripts --dry-run`
2. `npm run security:production`
3. `npm ls --omit=dev @modelcontextprotocol/sdk express express-rate-limit body-parser ip-address ajv fast-uri`
4. `npx vitest run tests/mcp-protocol-v2.test.ts tests/mcp-server.test.ts tests/mcp-workspace-symbols.test.ts tests/certification-package-smoke.test.ts`
5. `npm run build`
6. Exercise the built CLI through both the legacy raw package smoke and the modern stdio client test.
7. `npm run certify:packages`
8. `npm run build:standalone` to catch v2 ESM/subpath or bundling failures.
9. `npm run check`

The production `npm ls` command should show no legacy MCP dependency path; investigate rather than masking unexpected packages with overrides or audit exceptions.

## Documentation

Files: `docs/mcp.md`, `docs/cli.md`, `codegraph-skill/codegraph/SKILL.md`; update other canonical docs only if their statements become inaccurate.

- State that the bundled official v2 SDK serves the current modern MCP revision while retaining legacy 2025 clients.
- Clarify that protocol connection/session mechanics are distinct from the one shared warm Codegraph analysis session.
- Document Host and Origin enforcement for HTTP. Warn that `--host` outside loopback exposes an unauthenticated repository-analysis endpoint and is for trusted networks/containers only.
- Keep commands, flags, endpoint URL, installer examples, and tool catalog unchanged. Update the skill's MCP capability guidance because the supported protocol surface changes even though the CLI syntax does not.

## Acceptance criteria

- Official v2 clients negotiate the 2026-07-28 era over both stdio and HTTP and can list and call Codegraph tools.
- Existing 2025 clients continue to initialize and call tools over stdio and the current sessionful JSON HTTP path.
- HTTP Host, Origin, path, body-size, and JSON boundaries reject before protocol/tool work.
- All protocol instances share the same process-level Codegraph handlers/session; modern per-request serving does not rebuild the repository index per request.
- Production no longer installs the monolithic v1 SDK or its Express/rate-limit/Ajv dependency chain, and no MCP-derived root override or audit exception remains.
- Built, packed, and standalone artifacts resolve all v2 package subpaths and pass real MCP exchanges.
- Canonical MCP/CLI docs match the final transport and security behavior.
- Focused tests, package certification, standalone build, production audit, and `npm run check` pass.

## Plan-review corrections

- A package-only import migration was rejected: v2 hand-constructed transports remain in the 2025 era unless `serveStdio` and `createMcpHandler` are used.
- Replacing `McpServer` with low-level `Server` is valid for Codegraph's manual tool catalog and reduces indirection; the v2 serving factories accept either. No `x-mcp-header` declarations exist in Codegraph's schemas, so foregoing `McpServer` registry inspection loses no current behavior.
- A stateless legacy HTTP cutover was rejected for this PR despite deleting more code: it changes session IDs and potentially JSON/SSE response behavior. Preserve compatibility first; remove the legacy session path only through a separately reviewed deprecation decision.
- A repository-wide codemod was rejected because the SDK coupling is localized and manual edits are easier to review.
- Direct wire reimplementation was rejected. Use the official client for modern interoperability and the SDK classifier/Node adapter for routing; retain raw tests only for Codegraph-owned compatibility and security boundaries.

After implementation and verification, delete this completed plan and remove its priority-index entry in the implementation PR; Git history preserves the design record.
