import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { BuildOptions, BuildReport } from "../indexer/types.js";
import type { ReviewBuildReport } from "../review.js";
import { normalizePath, resolveFilePathFromRoot } from "../util/paths.js";
import { isCliValueOption, type ParsedCliArgs } from "./options.js";
import {
  createCliProgressDisplay,
  resolveCliProgressPresentation,
  type CliProgressDisplay,
  type CliProgressPolicy,
} from "./progress.js";

function toJSON(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

export type CliRuntime = {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  exit: (code: number) => never;
  cwd: () => string;
  readStdin: () => Promise<string>;
  promptLine: (question: string) => Promise<string>;
  stdinIsTTY: () => boolean;
  stderrIsTTY: () => boolean;
  terminalSupportsControlSequences: () => boolean;
  progressPreparationDelayMs: () => number;
};

export type CliPositionalsContext = {
  positionals: string[];
};

export type CliRootContext = {
  root: string;
};

export type CliGetOptContext = {
  getOpt: (name: string) => string | undefined;
};

export type CliFlagContext = {
  hasFlag: (name: string) => boolean;
};

export type CliOptionContext = CliGetOptContext & CliFlagContext;

export type CliCwdContext = {
  cwd: () => string;
};

export type CliJsonWriterContext = {
  writeJSONLine: (value: unknown) => void;
};

export type CliStdoutWriterContext = {
  writeStdoutLine: (message: string) => void;
};

export type CliStderrExitContext = {
  writeStderrLine: (message: string) => void;
  exit: (code: number) => never;
};

export type CliAgentCommandContext = {
  positionals: string[];
  root: string;
  buildOptions?: BuildOptions;
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
  writeStderrLine: (message: string) => void;
  exit: (code: number) => never;
};

type CliContext = {
  runtime: CliRuntime;
  stderrFilePath: string | undefined;
  progressDisplay: CliProgressDisplay | undefined;
};

function createDefaultCliRuntime(): CliRuntime {
  return {
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
    exit: (code) => process.exit(code),
    cwd: () => process.cwd(),
    stdinIsTTY: () => !!process.stdin.isTTY,
    stderrIsTTY: () => !!process.stderr.isTTY,
    terminalSupportsControlSequences: () => !!process.stderr.isTTY && process.env.TERM !== "dumb",
    progressPreparationDelayMs: () => 100,
    readStdin: async () =>
      await new Promise<string>((resolve, reject) => {
        let data = "";

        function cleanup() {
          process.stdin.off("data", onData);
          process.stdin.off("end", onEnd);
          process.stdin.off("error", onError);
        }

        function onData(chunk: Buffer | string) {
          data += chunk.toString();
        }

        function onEnd() {
          cleanup();
          resolve(data);
        }

        function onError(error: Error) {
          cleanup();
          reject(error);
        }

        process.stdin.on("data", onData);
        process.stdin.once("end", onEnd);
        process.stdin.once("error", onError);
      }),
    promptLine: async (question) => {
      const { createInterface } = await import("node:readline/promises");
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await prompt.question(question);
      } finally {
        prompt.close();
      }
    },
  };
}

const defaultCliContext: CliContext = {
  runtime: createDefaultCliRuntime(),
  stderrFilePath: undefined,
  progressDisplay: undefined,
};
const cliContextStorage = new AsyncLocalStorage<CliContext>();

function createCliContext(runtime: Partial<CliRuntime> = {}): CliContext {
  return {
    runtime: { ...createDefaultCliRuntime(), ...runtime },
    stderrFilePath: undefined,
    progressDisplay: undefined,
  };
}

function getCliContext(): CliContext {
  return cliContextStorage.getStore() ?? defaultCliContext;
}

export async function runWithCliRuntime<T>(runtime: Partial<CliRuntime>, callback: () => Promise<T>): Promise<T> {
  const context = createCliContext(runtime);
  return await cliContextStorage.run(context, async () => {
    try {
      return await callback();
    } finally {
      context.progressDisplay?.dispose();
    }
  });
}

export function getCwd(): string {
  return getCliContext().runtime.cwd();
}

export async function readCliStdin(): Promise<string> {
  return await getCliContext().runtime.readStdin();
}

export function isCliInteractiveTerminal(): boolean {
  const runtime = getCliContext().runtime;
  return runtime.stdinIsTTY() && runtime.stderrIsTTY();
}

export async function promptCliLine(question: string): Promise<string> {
  return await getCliContext().runtime.promptLine(question);
}

export function exitCli(code: number): never {
  return getCliContext().runtime.exit(code);
}

export function setCliStderrFilePath(filePath: string | undefined): void {
  getCliContext().stderrFilePath = filePath;
}

export function writeStdoutLine(message: string): void {
  const context = getCliContext();
  context.progressDisplay?.clear();
  context.runtime.stdout(`${message}\n`);
}

export function writeJSONLine(value: unknown): void {
  writeStdoutLine(toJSON(value));
}

export function writeStderrLine(message: string): void {
  const context = getCliContext();
  context.progressDisplay?.clear();
  context.runtime.stderr(`${message}\n`);
  try {
    if (context.stderrFilePath) {
      fs.appendFileSync(context.stderrFilePath, `${message}\n`, {
        encoding: "utf8",
      });
    }
  } catch {
    // Swallow file logging errors to avoid masking primary error output.
  }
}

export function writeError(error: unknown): void {
  if (error instanceof Error) {
    writeStderrLine(error.stack ?? error.message);
    return;
  }
  writeStderrLine(String(error));
}

function formatNativeBackendStatus(report: BuildReport | undefined): string | undefined {
  const native = report?.backend?.native;
  if (!native) return undefined;
  if (native.filesUsed > 0) {
    if (native.filesFellBack > 0) {
      return `Backend: native tree-sitter used for ${native.filesUsed} file(s); fallback for ${native.filesFellBack} file(s)`;
    }
    return `Backend: native tree-sitter used for ${native.filesUsed} file(s)`;
  }
  const fallbackTotal = native.filesFellBack;
  if (native.available) {
    if (fallbackTotal > 0) {
      return `Backend: reduced graph/regex mode for ${fallbackTotal} file(s)`;
    }
    return "Backend: native tree-sitter available";
  }
  const reason = native.loadError ? ` (${native.loadError})` : "";
  return `Backend: reduced graph/regex mode; native addon unavailable${reason}`;
}

function formatNativeBackendFallbackSummary(report: BuildReport | undefined): string | undefined {
  const native = report?.backend?.native;
  if (!native || native.filesFellBack === 0) return undefined;
  const parts = Object.entries(native.byLanguage)
    .filter(([, entry]) => entry.filesFellBack > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([languageId, entry]) => {
      const reasonSummary = Object.entries(entry.fallbackReasons)
        .filter(([, count]) => count > 0)
        .map(([reason, count]) => `${reason}=${count}`)
        .join(",");
      return reasonSummary.length ? `${languageId}(${reasonSummary})` : `${languageId}(${entry.filesFellBack})`;
    });
  if (!parts.length) return undefined;
  return `Native fallback summary: ${parts.join(", ")}`;
}

function formatParserBackendSummary(report: BuildReport | undefined): string | undefined {
  const parser = report?.backend?.parser;
  if (!parser || parser.total === 0) return undefined;
  const parts = Object.entries(parser.byLanguage)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([languageId, count]) => `${languageId}(${count})`);
  if (!parts.length) {
    return `Parser backend degradation: ${parser.total} file(s)`;
  }
  return `Parser backend degradation: ${parser.total} file(s) [${parts.join(", ")}]`;
}

export function maybeWriteNativeBackendStatus(report: BuildReport | undefined, showProgress: boolean): void {
  if (!showProgress) return;
  const message = formatNativeBackendStatus(report);
  if (message) writeStderrLine(message);
  const summary = formatNativeBackendFallbackSummary(report);
  if (summary) writeStderrLine(summary);
  const parserSummary = formatParserBackendSummary(report);
  if (parserSummary) writeStderrLine(parserSummary);
}

export function createCliProgressHandler(policy: CliProgressPolicy): BuildOptions["onProgress"] {
  const context = getCliContext();
  const presentation = resolveCliProgressPresentation({
    policy,
    stderrIsTTY: context.runtime.stderrIsTTY(),
    terminalSupportsControlSequences: context.runtime.terminalSupportsControlSequences(),
  });
  if (presentation === "off") return undefined;

  context.progressDisplay?.dispose();
  const display = createCliProgressDisplay({
    presentation,
    write: context.runtime.stderr,
  });
  context.progressDisplay = display;
  return display.update;
}

type CommandTimingReport = {
  totalMs?: number;
  resolveFilesMs?: number;
  commandMs?: number;
};

export type CommandReport = {
  command: string;
  timings: CommandTimingReport;
  index?: BuildReport;
  review?: ReviewBuildReport;
};

function isSupportedShortFlagToken(token: string): boolean {
  return token === "-h" || token === "-v" || token === "-o";
}

function isCliOptionValueToken(token: string): boolean {
  return !token.startsWith("--") && !isSupportedShortFlagToken(token);
}

export function parseCliArgs(command: string, tokens: string[]): ParsedCliArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string[]>();

  const pushOpt = (key: string, value: string) => {
    const existing = options.get(key);
    if (existing) existing.push(value);
    else options.set(key, [value]);
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }

    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      if (eq !== -1) {
        const key = t.slice(0, eq);
        const value = t.slice(eq + 1);
        pushOpt(key, value);
        continue;
      }
      const key = t;
      if (isCliValueOption(command, key, positionals)) {
        const next = tokens[i + 1];
        if (next === undefined || !isCliOptionValueToken(next)) {
          throw new Error(`Missing value for ${key} option`);
        }
        pushOpt(key, next);
        i++;
      } else {
        flags.add(key);
      }
      continue;
    }

    if (t.startsWith("-") && t.length > 1) {
      // Support a minimal set of short options. Everything else is treated as a boolean flag.
      if (t === "-o") {
        const next = tokens[i + 1];
        if (!next || next.startsWith("-")) throw new Error("Missing value for -o/--output");
        pushOpt("--output", next);
        i++;
        continue;
      }
      flags.add(t);
      continue;
    }

    positionals.push(t);
  }

  return { positionals, flags, options };
}

export async function writeCommandReport(report: CommandReport, reportFile: string | undefined): Promise<void> {
  const payload = JSON.stringify(report, null, 2);
  if (reportFile) {
    const resolved = normalizePath(resolveFilePathFromRoot(getCwd(), reportFile));
    await fsp.writeFile(resolved, `${payload}\n`, "utf8");
  } else {
    writeStderrLine(payload);
  }
}
