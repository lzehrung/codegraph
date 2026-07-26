import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCliOrThrow } from "./helpers/cli.js";

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function jsonRecord(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

describe("forgiving CLI inputs", () => {
  let root = "";

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-forgiving-cli-"));
    await fsp.writeFile(
      path.join(root, "main.ts"),
      [
        "export function target(): number { return 1; }",
        "export function caller(): number { return target(); }",
        "",
      ].join("\n"),
      "utf8",
    );
    await fsp.writeFile(path.join(root, "single.ts"), "export const only = 1;\n", "utf8");
    git(root, ["init"]);
    git(root, ["config", "user.email", "tests@example.com"]);
    git(root, ["config", "user.name", "Tests"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "fixture"]);
  });

  afterAll(async () => {
    if (root) await fsp.rm(root, { recursive: true, force: true });
  });

  test("accepts source locations and file-wide navigation", async () => {
    const { stdout: preciseRefs } = await runCliOrThrow(["refs", "main.ts:1:17", "--root", root, "--json"]);
    const precise = jsonRecord(preciseRefs);
    expect(precise.status).toBe("ok");
    expect(precise.definition).toMatchObject({ localName: "target" });

    const { stdout: fileRefs } = await runCliOrThrow(["refs", "main.ts", "--root", root, "--json"]);
    const aggregate = jsonRecord(fileRefs);
    expect(aggregate.status).toBe("ok");
    expect(aggregate.symbols).toHaveLength(2);
    expect(aggregate.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ definition: expect.objectContaining({ localName: "target" }) }),
      ]),
    );

    const ambiguousGoto = jsonRecord((await runCliOrThrow(["goto", "main.ts", "--root", root, "--json"])).stdout);
    expect(ambiguousGoto.status).toBe("ambiguous");
    expect(ambiguousGoto.candidates).toHaveLength(2);

    const singleGoto = jsonRecord((await runCliOrThrow(["goto", "single.ts", "--root", root, "--json"])).stdout);
    expect(singleGoto.status).toBe("ok");
    expect(singleGoto.definition).toMatchObject({ localName: "only" });

    const symbol = jsonRecord((await runCliOrThrow(["callers", "target", "--root", root, "--json"])).stdout);
    const target = symbol.target as { handle?: unknown };
    expect(typeof target.handle).toBe("string");
    const handle = String(target.handle);
    expect(jsonRecord((await runCliOrThrow(["goto", handle, "--root", root, "--json"])).stdout).status).toBe("ok");
    expect(jsonRecord((await runCliOrThrow(["refs", handle, "--root", root, "--json"])).stdout).status).toBe("ok");

    const fileView = jsonRecord(
      (await runCliOrThrow(["file", `${path.join(root, "main.ts")}:2`, "--root", root, "--json"])).stdout,
    );
    expect(fileView.offset).toBe(2);
    expect(fileView.content).toContain("caller");
  });

  test("resolves unique exact symbol names for semantic commands", async () => {
    const output = await runCliOrThrow(["callers", "target", "--root", root, "--json"]);
    const result = jsonRecord(output.stdout);
    expect(result.target).toMatchObject({ name: "target", location: { file: "main.ts" } });
    expect(result.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ symbol: expect.objectContaining({ name: "caller" }) })]),
    );
  });

  test("infers simple subcommands and positional query forms", async () => {
    const grepOutput = await runCliOrThrow(["grep", "target", "--root", root, "--json"]);
    const grepResults: unknown = JSON.parse(grepOutput.stdout);
    expect(grepResults).toEqual(expect.arrayContaining([expect.objectContaining({ file: "main.ts" })]));

    const packet = jsonRecord((await runCliOrThrow(["packet", "main.ts:1:17", "--root", root, "--json"])).stdout);
    expect(packet.kind).toBe("file");
    await runCliOrThrow(["deps", "main.ts:1:17", "--root", root, "--json"]);

    const artifactDir = path.join(root, "artifact-out");
    const artifact = jsonRecord(
      (await runCliOrThrow(["artifact", "--root", root, "--out", artifactDir, "--json"])).stdout,
    );
    expect(artifact.outDir).toBe(artifactDir);

    const sqlitePath = path.join(root, "graph.sqlite");
    await runCliOrThrow(["graph", "--root", root, "--sqlite", sqlitePath]);
    const sql = jsonRecord(
      (await runCliOrThrow(["sql", sqlitePath, "SELECT COUNT(*) AS count FROM files", "--json"])).stdout,
    );
    expect(sql.columns).toEqual(["count"]);
    expect(sql.rows).toEqual([[expect.any(Number)]]);
  });

  test("defaults git comparisons to HEAD and WORKTREE", async () => {
    await fsp.appendFile(path.join(root, "main.ts"), "export const changed = target();\n", "utf8");

    const impact = jsonRecord((await runCliOrThrow(["impact", "--root", root, "--json"])).stdout);
    expect(impact.changedFiles).toEqual(expect.arrayContaining([expect.objectContaining({ file: "main.ts" })]));

    const drift = jsonRecord((await runCliOrThrow(["drift", "--root", root, "--json"])).stdout);
    expect(drift.base).toMatchObject({ ref: "HEAD" });
    expect(drift.head).toMatchObject({ ref: "WORKTREE" });
  });

  test("accepts a positional project root where it is unambiguous", async () => {
    const result: unknown = JSON.parse((await runCliOrThrow(["apisurface", root, "--json"])).stdout);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exports: expect.arrayContaining([expect.objectContaining({ name: "target" })]) }),
      ]),
    );

    const doctor = jsonRecord((await runCliOrThrow(["doctor", root, "--json"])).stdout);
    expect(doctor.package).toMatchObject({ name: "@lzehrung/codegraph" });
  });
});
