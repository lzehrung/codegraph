import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import type { BuildReport } from "../indexer/types.js";
import type { ReviewBuildReport } from "../review.js";
import { normalizePath, resolveFilePathFromRoot, type ProjectFileDiscoveryOptions } from "../util.js";
import { isRelativePathInside } from "../util/projectFiles.js";
import { isCliValueOption } from "./options.js";

function toJSON(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

function normalizeCliGlobPattern(globPattern: string): string {
  return globPattern.trim().replace(/\\/g, "/");
}

export function isCliDiscoveryRelativePathInside(relativePath: string): boolean {
  return isRelativePathInside(relativePath);
}

function matchesCliDiscoveryGlob(
  absolutePath: string,
  scanRoot: string,
  matcher: (relativePath: string) => boolean,
): boolean {
  const relativePath = path.relative(scanRoot, absolutePath);
  if (!isCliDiscoveryRelativePathInside(relativePath)) {
    return false;
  }
  return matcher(normalizePath(relativePath));
}

export function filterFilesByCliDiscoveryGlobs(
  files: readonly string[],
  scanRoot: string,
  discovery: ProjectFileDiscoveryOptions,
): string[] {
  const includeMatchers = (discovery.includeGlobs ?? [])
    .map(normalizeCliGlobPattern)
    .filter(Boolean)
    .map((globPattern) => picomatch(globPattern, { dot: true }));
  const ignoreMatchers = (discovery.ignoreGlobs ?? [])
    .map(normalizeCliGlobPattern)
    .filter(Boolean)
    .map((globPattern) => picomatch(globPattern, { dot: true }));

  if (!includeMatchers.length && !ignoreMatchers.length) {
    return [...files];
  }

  return files.filter((filePath) => {
    if (
      includeMatchers.length &&
      !includeMatchers.some((matcher) => matchesCliDiscoveryGlob(filePath, scanRoot, matcher))
    ) {
      return false;
    }
    return !ignoreMatchers.some((matcher) => matchesCliDiscoveryGlob(filePath, scanRoot, matcher));
  });
}

export type CliRuntime = {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  exit: (code: number) => never;
  cwd: () => string;
};

type CliContext = {
  runtime: CliRuntime;
  stderrFilePath: string | undefined;
};

function createDefaultCliRuntime(): CliRuntime {
  return {
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
    exit: (code) => process.exit(code),
    cwd: () => process.cwd(),
  };
}

const defaultCliContext: CliContext = {
  runtime: createDefaultCliRuntime(),
  stderrFilePath: undefined,
};
const cliContextStorage = new AsyncLocalStorage<CliContext>();

function createCliContext(runtime: Partial<CliRuntime> = {}): CliContext {
  return {
    runtime: { ...createDefaultCliRuntime(), ...runtime },
    stderrFilePath: undefined,
  };
}

function getCliContext(): CliContext {
  return cliContextStorage.getStore() ?? defaultCliContext;
}

export async function runWithCliRuntime<T>(runtime: Partial<CliRuntime>, callback: () => Promise<T>): Promise<T> {
  const context = createCliContext(runtime);
  return await cliContextStorage.run(context, callback);
}

export function getCwd(): string {
  return getCliContext().runtime.cwd();
}

export function exitCli(code: number): never {
  return getCliContext().runtime.exit(code);
}

function writeStderrChunk(message: string): void {
  getCliContext().runtime.stderr(message);
}

export function setCliStderrFilePath(filePath: string | undefined): void {
  getCliContext().stderrFilePath = filePath;
}

export function writeStdoutLine(message: string): void {
  getCliContext().runtime.stdout(`${message}\n`);
}

export function writeJSONLine(value: unknown): void {
  writeStdoutLine(toJSON(value));
}

export function writeStderrLine(message: string): void {
  const context = getCliContext();
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
      return `Backend: JS tree-sitter fallback for ${fallbackTotal} file(s)`;
    }
    return "Backend: native tree-sitter available";
  }
  const reason = native.loadError ? ` (${native.loadError})` : "";
  return `Backend: JS tree-sitter fallback; native addon unavailable${reason}`;
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

export function createCliProgressHandler(
  showProgress: boolean,
): ((update: { current: number; total: number }) => void) | undefined {
  if (!showProgress) return undefined;
  let lastProgressUpdate = 0;
  return (update) => {
    const now = Date.now();
    const isComplete = update.current === update.total;
    const shouldUpdate = isComplete || now - lastProgressUpdate > 100;

    if (shouldUpdate) {
      if (process.stderr.isTTY) {
        writeStderrChunk(`\r[Progress] ${update.current}/${update.total} files processed...`);
        if (isComplete) {
          writeStderrChunk("\n");
        }
      } else if (update.current === 1 || isComplete || update.current % 100 === 0) {
        writeStderrChunk(`[Progress] ${update.current}/${update.total} files processed.\n`);
      }
      lastProgressUpdate = now;
    }
  };
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

export type ParsedCliArgs = {
  positionals: string[];
  flags: Set<string>;
  options: Map<string, string[]>;
};

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
        if (next === undefined) throw new Error(`Missing value for ${key} option`);
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
