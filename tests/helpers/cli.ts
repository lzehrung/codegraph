import { spawn } from "node:child_process";
import path from "node:path";
import { runCli } from "../../src/cli.js";

export type CapturedCliResult = {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
};

export type SuccessfulCliResult = {
  stdout: string;
  stderr: string;
};

export type CliCaptureOptions = {
  cwd?: string | undefined;
  stdin?: string | (() => string | Promise<string>) | undefined;
  stdinIsTTY?: boolean | undefined;
  stderrIsTTY?: boolean | undefined;
  terminalSupportsControlSequences?: boolean | undefined;
  progressPreparationDelayMs?: number | undefined;
  onStderr?: (chunk: string) => void;
};
export type TsxScriptCaptureOptions = {
  cwd?: string | undefined;
  stdin?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
};
const cliExitPrefix = "codegraph test CLI exit";
const tsxCliPath = path.resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

async function readCliStdin(stdin: CliCaptureOptions["stdin"]): Promise<string> {
  if (typeof stdin === "function") return await stdin();
  return stdin ?? "";
}

export function stripCliProgressLines(stderr: string): string {
  return stderr.replace(/^\[Progress\].*(?:\r?\n|$)/gm, "");
}

export async function captureCli(args: string[], options: CliCaptureOptions = {}): Promise<CapturedCliResult> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;

  await runCli(args, {
    cwd: () => options.cwd ?? process.cwd(),
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    },
    readStdin: async () => await readCliStdin(options.stdin),
    promptLine: async (question) => {
      stderr += question;
      return (await readCliStdin(options.stdin)).split(/\r?\n/, 1)[0] ?? "";
    },
    stdinIsTTY: () => options.stdinIsTTY ?? options.stderrIsTTY ?? false,
    stderrIsTTY: () => options.stderrIsTTY ?? false,
    terminalSupportsControlSequences: () => options.terminalSupportsControlSequences ?? options.stderrIsTTY ?? false,
    exit: (code) => {
      exitCode = code;
      throw new Error(`${cliExitPrefix} ${code}`);
    },
  }).catch((error: unknown) => {
    if (error instanceof Error && exitCode !== undefined && error.message === `${cliExitPrefix} ${exitCode}`) {
      return;
    }
    throw error;
  });

  return { stdout, stderr, exitCode };
}

export async function runCliOrThrow(args: string[], options: CliCaptureOptions = {}): Promise<SuccessfulCliResult> {
  const result = await captureCli(args, options);
  if (result.exitCode !== undefined) {
    throw new Error(`codegraph CLI failed (${result.exitCode}). stderr:\n${result.stderr}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function runCliStdout(args: string[], options: CliCaptureOptions = {}): Promise<string> {
  const result = await runCliOrThrow(args, options);
  return result.stdout;
}

export async function captureTsxScript(
  entryPath: string,
  args: string[] = [],
  options: TsxScriptCaptureOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const child = spawn(process.execPath, [tsxCliPath, entryPath, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const { promise, resolve, reject } = Promise.withResolvers<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }>();

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  if (options.stdin !== undefined) child.stdin.write(options.stdin);
  child.stdin.end();

  child.on("error", reject);
  child.on("close", (exitCode) => {
    resolve({ stdout, stderr, exitCode });
  });

  return await promise;
}

export async function runTsxScriptOrThrow(
  entryPath: string,
  args: string[] = [],
  options: TsxScriptCaptureOptions = {},
  failureLabel = "tsx script",
): Promise<SuccessfulCliResult> {
  const result = await captureTsxScript(entryPath, args, options);
  if (result.exitCode !== 0) {
    throw new Error(`${failureLabel} failed (${result.exitCode}). stderr:\n${result.stderr}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}
