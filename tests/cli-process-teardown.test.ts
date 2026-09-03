import { describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isPlainRecord } from "../src/util/guards.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledCli = path.join(rootDir, "dist", "bin", "cli.js");
const FUNNEL_EXPLORE_QUERY = "where does authentication reach storage?";
const WINDOWS_ABORT_EXIT = 3221226505;

function runExplore(root: string) {
  return spawnSync(process.execPath, [bundledCli, "explore", FUNNEL_EXPLORE_QUERY, "--root", root, "--json"], {
    cwd: rootDir,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function createTinyRepository(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-teardown-"));
  await fsp.mkdir(path.join(root, "src"), { recursive: true });
  await fsp.writeFile(
    path.join(root, "src", "auth.ts"),
    [
      'import { storeAuthenticatedSession } from "./storage.js";',
      "",
      "// Authentication reaches storage through the authenticated session write.",
      "export function authenticationReachesStorage(token: string) {",
      "  return storeAuthenticatedSession(token);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fsp.writeFile(
    path.join(root, "src", "storage.ts"),
    [
      "// Storage receives the authenticated session from the authentication flow.",
      "export function storeAuthenticatedSession(token: string) {",
      '  return { storage: "session-store", token };',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fsp.writeFile(
    path.join(root, "src", "certified.ts"),
    'export function CertifiedPackageSymbol(): string { return "certified"; }\n',
    "utf8",
  );
  return root;
}

function assertSuccessfulExplore(result: ReturnType<typeof runExplore>, label: string): void {
  expect(result.status, `${label} stderr:\n${result.stderr}`).toBe(0);
  expect(result.status).not.toBe(WINDOWS_ABORT_EXIT);
  expect(result.stderr).not.toMatch(/UV_HANDLE_CLOSING/);
  const parsed: unknown = JSON.parse(result.stdout);
  expect(isPlainRecord(parsed)).toBe(true);
  if (!isPlainRecord(parsed)) return;
  expect(parsed.schemaVersion).toBe(1);
  expect(parsed.query).toBe(FUNNEL_EXPLORE_QUERY);
  expect(Array.isArray(parsed.anchors)).toBe(true);
  if (!Array.isArray(parsed.anchors)) return;
  expect(parsed.anchors.length).toBeGreaterThan(0);
}

describe("CLI process teardown after warm explore", () => {
  it("exits 0 from a real process on first and warm explore", async () => {
    expect(fs.existsSync(bundledCli)).toBe(true);
    const root = await createTinyRepository();
    try {
      const first = runExplore(root);
      assertSuccessfulExplore(first, "first-query");
      const warm = runExplore(root);
      assertSuccessfulExplore(warm, "warm-query");
    } finally {
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
