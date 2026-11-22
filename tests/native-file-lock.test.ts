import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { tryLockExclusive } from "../packages/codegraph-native/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function lockPath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-native-lock-"));
  roots.push(root);
  return path.join(root, "lock");
}

describe("native exclusive file locks", () => {
  it("excludes other handles until release and does not unlock a replacement twice", async () => {
    const file = await lockPath();
    const first = tryLockExclusive(file);
    expect(first).toBeTruthy();
    if (!first) throw new Error("Expected the first lock to succeed.");
    expect(tryLockExclusive(file)).toBeFalsy();
    const independent = tryLockExclusive(`${file}-other`);
    expect(independent).toBeTruthy();
    independent?.unlock();
    first.unlock();
    const replacement = tryLockExclusive(file);
    expect(replacement).toBeTruthy();
    try {
      first.unlock();
      expect(tryLockExclusive(file)).toBeFalsy();
    } finally {
      replacement?.unlock();
    }
    const afterRelease = tryLockExclusive(file);
    expect(afterRelease).toBeTruthy();
    afterRelease?.unlock();
    expect(() => tryLockExclusive(path.join(file, "missing", "lock"))).toThrow();
  });

  it("marks open failures separately from lock failures", async () => {
    const file = await lockPath();
    try {
      tryLockExclusive(path.join(file, "missing", "lock"));
      expect.fail("Expected opening the lock to fail.");
    } catch (error) {
      expect(error).toMatchObject({ code: "CODEGRAPH_LOCK_OPEN_FAILED" });
    }
  });

  it.skipIf(process.platform !== "win32")("prevents deleting a locked sidecar on Windows", async () => {
    const file = await lockPath();
    const lock = tryLockExclusive(file);
    if (!lock) throw new Error("Expected the lock to succeed.");
    try {
      await expect(fs.rm(file)).rejects.toThrow();
    } finally {
      lock.unlock();
    }
    await expect(fs.rm(file)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("locks an existing read-only sidecar", async () => {
    const file = await lockPath();
    await fs.writeFile(file, "");
    await fs.chmod(file, 0o444);
    try {
      const lock = tryLockExclusive(file);
      expect(lock).toBeTruthy();
      lock?.unlock();
    } finally {
      await fs.chmod(file, 0o600);
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports the lock directory and ownership remedy when creation is denied",
    async () => {
      const file = await lockPath();
      const directory = path.dirname(file);
      await fs.chmod(directory, 0o555);
      try {
        expect(() => tryLockExclusive(file)).toThrow(directory);
        expect(() => tryLockExclusive(file)).toThrow("chown -R <user> <directory>");
      } finally {
        await fs.chmod(directory, 0o700);
      }
    },
  );

  it("releases a collected handle without an explicit unlock", async () => {
    const file = await lockPath();
    const addon = pathToFileURL(path.resolve("packages/codegraph-native/index.js")).href;
    const script = [
      `import { tryLockExclusive } from ${JSON.stringify(addon)};`,
      'import { setImmediate } from "node:timers/promises";',
      `const file = ${JSON.stringify(file)};`,
      "let lock = tryLockExclusive(file);",
      'if (!lock) throw new Error("Failed to acquire lock");',
      'process.send("locked");',
      'process.on("message", async (message) => {',
      '  if (message !== "collect") return;',
      "  lock = null;",
      "  for (let attempt = 0; attempt < 100; attempt += 1) {",
      "    global.gc();",
      "    await setImmediate();",
      "    const replacement = tryLockExclusive(file);",
      "    if (!replacement) continue;",
      "    replacement.unlock();",
      '    process.send("collected");',
      "    process.disconnect();",
      "    return;",
      "  }",
      '  throw new Error("Native lock was not finalized");',
      "});",
    ].join("\n");
    const child = spawn(process.execPath, ["--expose-gc", "--input-type=module", "--eval", script], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    });
    const ready = Promise.withResolvers<void>();
    const collected = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", ready.reject);
    child.once("close", (code) => {
      closed.resolve();
      const error = new Error(`GC lock holder exited ${code}: ${stderr}`);
      ready.reject(error);
      collected.reject(error);
    });
    child.on("message", (message: unknown) => {
      if (message === "locked") ready.resolve();
      if (message === "collected") collected.resolve();
    });
    try {
      await ready.promise;
      expect(tryLockExclusive(file)).toBeFalsy();
      child.send("collect");
      await collected.promise;
      const replacement = tryLockExclusive(file);
      expect(replacement).toBeTruthy();
      replacement?.unlock();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed.promise;
    }
  });

  it("releases the kernel lock immediately when its owning process is killed", async () => {
    const file = await lockPath();
    const addon = pathToFileURL(path.resolve("packages/codegraph-native/index.js")).href;
    const script = [
      `import { tryLockExclusive } from ${JSON.stringify(addon)};`,
      `const lock = tryLockExclusive(${JSON.stringify(file)});`,
      'if (!lock) throw new Error("Failed to acquire lock");',
      'process.on("message", () => lock.unlock());',
      'process.send("locked");',
      "process.channel.ref();",
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    });
    const closed = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", ready.reject);
    child.once("close", (code) => {
      closed.resolve();
      ready.reject(new Error(`Lock holder exited ${code}: ${stderr}`));
    });
    child.on("message", (message: unknown) => {
      if (message === "locked") ready.resolve();
    });
    try {
      await ready.promise;
      expect(tryLockExclusive(file)).toBeFalsy();
      expect(child.kill("SIGKILL")).toBe(true);
      await closed.promise;
      const recovered = tryLockExclusive(file);
      expect(recovered).toBeTruthy();
      recovered?.unlock();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed.promise;
    }
  });
});
