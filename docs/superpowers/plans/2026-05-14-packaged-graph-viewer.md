# Packaged Graph Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the existing static graph viewer with the npm package and make it easy to open graph artifacts from the CLI.

**Architecture:** Keep the viewer as a human-facing static asset, separate from MCP. Publish `docs/graph-visualization` with the package and add a small CLI launcher that serves the bundled files with Node's built-in HTTP server, optionally opening a graph JSON artifact.

**Tech Stack:** TypeScript CLI, Node `http`, existing `docs/graph-visualization` static files, Vitest package/CLI smoke tests.

---

## File Structure

- Modify: `package.json`
  - Include `docs/graph-visualization` in published package files.
- Modify: `src/cli.ts`
  - Add `codegraph viewer` command parsing.
- Create: `src/cli/viewer.ts`
  - Resolve the packaged viewer directory, start the static server, validate graph paths, and print/open the viewer URL.
- Modify: `src/cli/help.ts`
  - Document `viewer`.
- Modify: `tests/package-metadata.test.ts`
  - Prove `npm pack --dry-run --json` includes viewer assets.
- Modify: `tests/cli-regressions.test.ts`
  - Cover `codegraph viewer --print-url` or equivalent non-blocking URL generation.
- Modify: `README.md`, `docs/cli.md`, `docs/agent-workflows.md`, `codegraph-skill/codegraph/SKILL.md`
  - Document the packaged viewer workflow concisely.

## Task 1: Package the Viewer Assets

**Files:**

- Modify: `package.json`
- Test: `tests/package-metadata.test.ts`

- [ ] **Step 1: Add a failing package metadata test**

Add assertions that the package tarball includes these paths:

```ts
expect(files).toContain("package/docs/graph-visualization/index.html");
expect(files).toContain("package/docs/graph-visualization/app.js");
expect(files).toContain("package/docs/graph-visualization/styles.css");
```

Run: `npx vitest run tests/package-metadata.test.ts`

Expected: FAIL because the package `files` list currently excludes `docs/graph-visualization`.

- [ ] **Step 2: Include the viewer in package files**

Update `package.json`:

```json
"files": [
  "dist",
  "codegraph-skill",
  "docs/graph-visualization"
]
```

- [ ] **Step 3: Verify package metadata**

Run: `npx vitest run tests/package-metadata.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add package.json tests/package-metadata.test.ts
git commit -m "feat: package graph viewer assets"
```

## Task 2: Add a Viewer CLI Launcher

**Files:**

- Create: `src/cli/viewer.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli/help.ts`
- Test: `tests/cli-regressions.test.ts`

- [ ] **Step 1: Add failing CLI tests**

Cover a non-blocking mode so tests do not leave a server running:

```ts
const stdout = await runCliCommand(["viewer", "--root", root, "--graph", graphPath, "--print-url"]);
expect(stdout).toContain("http://127.0.0.1:");
expect(stdout).toContain("graph=");
```

Also cover path confinement:

```ts
await expect(runCliCommandDetailed(["viewer", "--root", root, "--graph", outsidePath, "--print-url"])).rejects.toThrow(
  /outside/i,
);
```

Run: `npx vitest run tests/cli-regressions.test.ts -t viewer`

Expected: FAIL because `viewer` is not implemented.

- [ ] **Step 2: Implement `src/cli/viewer.ts`**

Implement these exported functions:

```ts
export type ViewerOptions = {
  root: string;
  graph?: string;
  host?: string;
  port?: number;
  open?: boolean;
  printUrl?: boolean;
};

export async function buildViewerUrl(options: ViewerOptions): Promise<string>;
export async function serveGraphViewer(options: ViewerOptions): Promise<{ url: string; close: () => Promise<void> }>;
```

Use `assertFilePathWithinRoot()` for graph paths. Resolve the viewer directory relative to the built CLI module first, then fall back to the repo source path for tests from `src`.

- [ ] **Step 3: Wire the CLI command**

Add `viewer` to `src/cli.ts` with:

```bash
codegraph viewer --root . --graph codegraph-out/graph.json --open
codegraph viewer --root . --graph codegraph-out/graph.json --print-url
```

`--print-url` must compute and print the URL without blocking. The default command should start the server, print the URL, and keep the process alive.

- [ ] **Step 4: Verify targeted CLI tests**

Run: `npx vitest run tests/cli-regressions.test.ts -t viewer`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/cli/help.ts src/cli/viewer.ts tests/cli-regressions.test.ts
git commit -m "feat: add graph viewer launcher"
```

## Task 3: Connect Artifacts and Docs

**Files:**

- Modify: `src/agent/artifact.ts`
- Modify: `docs/cli.md`
- Modify: `docs/agent-workflows.md`
- Modify: `README.md`
- Modify: `codegraph-skill/codegraph/SKILL.md`
- Test: `tests/artifact-build.test.ts`

- [ ] **Step 1: Add artifact guidance test**

Assert that `CODEGRAPH_REPORT.md` or `manifest.json` includes the viewer command:

```ts
expect(report).toContain("codegraph viewer --graph");
```

Run: `npx vitest run tests/artifact-build.test.ts`

Expected: FAIL until the artifact output mentions the packaged viewer.

- [ ] **Step 2: Add concise viewer guidance**

Document the workflow:

```bash
codegraph graph --root . --compact-json --output codegraph.json
codegraph viewer --root . --graph codegraph.json --open
```

Make clear that MCP remains the agent/tool transport and the viewer is a human inspection surface.

- [ ] **Step 3: Verify docs and artifact tests**

Run:

```bash
npx vitest run tests/artifact-build.test.ts tests/cli-regressions.test.ts tests/package-metadata.test.ts
npm run lint
npm run build
npm run test:ci
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/cli.md docs/agent-workflows.md codegraph-skill/codegraph/SKILL.md src/agent/artifact.ts tests/artifact-build.test.ts
git commit -m "docs: surface packaged graph viewer workflow"
```

## Self-Review Checklist

- [ ] The viewer is published once with the package, not copied into every artifact by default.
- [ ] The CLI uses Node built-ins and adds no runtime dependency.
- [ ] Graph paths are confined to the project root.
- [ ] `--print-url` gives tests a non-blocking path.
- [ ] Docs separate human viewer usage from MCP agent tooling.
- [ ] Package, CLI, docs, and skill surfaces are updated together.
