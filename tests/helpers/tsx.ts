import { spawn } from "node:child_process";
import path from "node:path";

export const tsxCliPath = path.resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

/**
 * Runs a TypeScript file through tsx with its stdout attached to `stdoutFd`, an open file, as a shell's `> file` does,
 * and resolves to the exit code and what the run wrote to stderr. The caller closes the descriptor.
 */
export async function runTsxScriptWithStdoutFile(
  entryPath: string,
  args: string[],
  stdoutFd: number,
): Promise<{ exitCode: number | null; stderr: string }> {
  const child = spawn(process.execPath, [tsxCliPath, entryPath, ...args], {
    windowsHide: true,
    cwd: process.cwd(),
    stdio: ["ignore", stdoutFd, "pipe"],
  });
  const { promise, resolve, reject } = Promise.withResolvers<{ exitCode: number | null; stderr: string }>();

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("error", reject);
  child.on("close", (exitCode) => {
    resolve({ exitCode, stderr });
  });

  return await promise;
}
