export type LogLevel = "error" | "warn" | "info" | "debug" | "silent";
export type LogSeverity = "error" | "warn" | "info" | "debug";

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  silent: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const LOG_SEVERITY_RANK: Record<LogSeverity, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export function shouldLog(
  level: LogLevel | undefined,
  severity: LogSeverity,
): boolean {
  const effectiveLevel = level ?? "warn";
  return LOG_LEVEL_RANK[effectiveLevel] >= LOG_SEVERITY_RANK[severity];
}

export function logWithLevel(
  level: LogLevel | undefined,
  severity: LogSeverity,
  ...args: unknown[]
): void {
  if (!shouldLog(level, severity)) return;

  if (severity === "error") {
    console.error(...args);
    return;
  }
  if (severity === "warn") {
    console.warn(...args);
    return;
  }
  if (severity === "info") {
    console.info(...args);
    return;
  }
  console.debug(...args);
}
