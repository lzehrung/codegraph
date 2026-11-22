import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isPlainRecord } from "../../src/util/guards.js";

export type LifecycleLeaseHolder = { pid: number; kill: () => Promise<void> };

/** Holds the actual compiled lifecycle lease until the test forcibly kills its process. */
export async function startLifecycleLeaseHolder(
  root: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<LifecycleLeaseHolder> {
  const module = pathToFileURL(path.resolve("dist/installer/locks.js")).href;
  const lock = path.join(root, ".codegraph-server.lock");
  const code = [
    `import { withInstallerLeaseLock } from ${JSON.stringify(module)};`,
    `await withInstallerLeaseLock(${JSON.stringify(lock)}, "lifecycle test holder", async () => {`,
    "  process.channel.ref();",
    '  process.send({ kind: "locked" });',
    "  await new Promise(() => {});",
    "});",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, ...options.env },
    windowsHide: true,
  });
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let stderr = "";
  let holding = false;
  let killRequested = false;
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.once("error", ready.reject);
  child.once("close", (code) => {
    closed.resolve();
    if (!holding) ready.reject(new Error(`Lease holder exited ${code}: ${stderr}`));
  });
  child.on("message", (message: unknown) => {
    if (!isPlainRecord(message) || message.kind !== "locked") return;
    holding = true;
    ready.resolve();
  });
  const kill = async (): Promise<void> => {
    if (!killRequested) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Lease holder exited before the forced stop: ${stderr}`);
      }
      if (!child.kill("SIGKILL")) throw new Error("Could not forcibly stop the lease holder.");
      killRequested = true;
    }
    await closed.promise;
  };
  try {
    await ready.promise;
    if (!child.pid) throw new Error("Lease holder did not provide a PID.");
    return { pid: child.pid, kill };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed.promise;
    throw error;
  }
}

/** Leaves a real killed holder's metadata expired, retaining its actual host/kernel/PID identity. */
export async function createExpiredLifecycleLease(root: string): Promise<{ lockPath: string; metadata: string }> {
  const holder = await startLifecycleLeaseHolder(root);
  const lockPath = path.join(root, ".codegraph-server.lock");
  let metadata: string;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(lockPath, "utf8"));
    if (!isPlainRecord(parsed)) throw new Error("Lease holder did not write an object.");
    parsed.leaseExpiresAt = new Date(Date.now() - 5_000).toISOString();
    metadata = `${JSON.stringify(parsed)}\n`;
  } finally {
    await holder.kill();
  }
  await fs.writeFile(lockPath, metadata);
  return { lockPath, metadata };
}
