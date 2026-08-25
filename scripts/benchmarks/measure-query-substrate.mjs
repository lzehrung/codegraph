import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function positiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function summary(values) {
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
  };
}

function runCli(cliPath, root, query, mode, cache, disableQuerySidecar = false) {
  const started = performance.now();
  const env = { ...process.env };
  if (disableQuerySidecar) env.CODEGRAPH_DISABLE_QUERY_SIDECAR = "1";
  const result = spawnSync(
    process.execPath,
    [cliPath, "search", query, "--root", root, "--mode", mode, "--cache", cache, "--json"],
    { cwd: root, encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024 },
  );
  const elapsedMs = performance.now() - started;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `CLI exited ${result.status}.`);
  JSON.parse(result.stdout);
  return elapsedMs;
}

const root = path.resolve(option("--root", process.cwd()));
const query = option("--query", "AgentSession");
const cliSamples = positiveInteger(option("--cli-samples", "5"), "--cli-samples");
const mcpSamples = positiveInteger(option("--mcp-samples", "10"), "--mcp-samples");
const includeBaseline = process.argv.includes("--include-baseline");
const cliPath = path.resolve(option("--cli", path.join(process.cwd(), "dist", "cli.js")));
if (!fs.existsSync(cliPath)) throw new Error(`Built CLI not found: ${cliPath}`);

runCli(cliPath, root, query, "text", "disk");
const cli = {};
for (const mode of ["hybrid", "text", "symbol", "path", "graph"]) {
  const values = [];
  for (let index = 0; index < cliSamples; index += 1) values.push(runCli(cliPath, root, query, mode, "disk"));
  cli[mode] = summary(values);
}

const baseline = {};
if (includeBaseline) {
  for (const mode of ["hybrid", "text", "symbol", "path", "graph"]) {
    const values = [];
    for (let index = 0; index < cliSamples; index += 1) {
      values.push(runCli(cliPath, root, query, mode, "disk", true));
    }
    baseline[mode] = summary(values);
  }
}

const { createCodegraphMcpHandlers } = await import(
  pathToFileURL(path.join(process.cwd(), "dist", "mcp", "server.js")).href
);
const handlers = createCodegraphMcpHandlers({ root, buildOptions: { cache: "disk" } });
await handlers.search({ query, mode: "hybrid", limit: 20 });
const mcpValues = [];
for (let index = 0; index < mcpSamples; index += 1) {
  const started = performance.now();
  await handlers.search({ query, mode: "hybrid", limit: 20 });
  mcpValues.push(performance.now() - started);
}

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      environment: { platform: process.platform, arch: process.arch, node: process.version },
      root,
      query,
      cli,
      ...(includeBaseline ? { baseline } : {}),
      mcp: summary(mcpValues),
    },
    null,
    2,
  )}\n`,
);
handlers.dispose();
