import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { inspectDistForTests } from "../scripts/ensure-dist-for-tests-lib.mjs";

async function createTempRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-dist-check-"));
  await fsp.mkdir(path.join(root, "src"), { recursive: true });
  await fsp.mkdir(path.join(root, "dist"), { recursive: true });
  await fsp.writeFile(path.join(root, "package.json"), "{\n}\n", "utf8");
  await fsp.writeFile(path.join(root, "tsconfig.json"), "{\n}\n", "utf8");
  return root;
}

async function setFileMtime(
  filePath: string,
  timestamp: Date,
  contents = "export const value = 1;\n",
): Promise<void> {
  await fsp.writeFile(filePath, contents, "utf8");
  await fsp.utimes(filePath, timestamp, timestamp);
}

async function setFreshnessInputsTimestamp(
  root: string,
  timestamp: Date,
): Promise<void> {
  await fsp.utimes(path.join(root, "package.json"), timestamp, timestamp);
  await fsp.utimes(path.join(root, "tsconfig.json"), timestamp, timestamp);
  await fsp.utimes(path.join(root, "src"), timestamp, timestamp);
}

describe("inspectDistForTests", () => {
  test("should require a build when required dist entries are missing", async () => {
    const root = await createTempRoot();

    try {
      await setFreshnessInputsTimestamp(
        root,
        new Date("2026-04-27T12:00:00.000Z"),
      );
      await setFileMtime(
        path.join(root, "src", "index.ts"),
        new Date("2026-04-27T12:00:00.000Z"),
      );

      expect(inspectDistForTests(root)).toMatchObject({
        needsBuild: true,
        reason: "missing",
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should require a build when sources are newer than dist artifacts", async () => {
    const root = await createTempRoot();
    const distTime = new Date("2026-04-27T12:00:00.000Z");
    const srcTime = new Date("2026-04-27T12:01:00.000Z");

    try {
      await setFreshnessInputsTimestamp(root, distTime);
      await setFileMtime(path.join(root, "dist", "index.js"), distTime, "export {};\n");
      await setFileMtime(path.join(root, "dist", "cli.js"), distTime, "export {};\n");
      await setFileMtime(path.join(root, "src", "index.ts"), srcTime);

      expect(inspectDistForTests(root)).toMatchObject({
        needsBuild: true,
        reason: "stale",
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should skip the build when dist artifacts are newer than inputs", async () => {
    const root = await createTempRoot();
    const srcTime = new Date("2026-04-27T12:00:00.000Z");
    const distTime = new Date("2026-04-27T12:01:00.000Z");

    try {
      await setFileMtime(path.join(root, "src", "nested.ts"), srcTime);
      await setFreshnessInputsTimestamp(root, srcTime);
      await setFileMtime(path.join(root, "dist", "index.js"), distTime, "export {};\n");
      await setFileMtime(path.join(root, "dist", "cli.js"), distTime, "export {};\n");

      expect(inspectDistForTests(root)).toMatchObject({
        needsBuild: false,
        reason: "fresh",
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
