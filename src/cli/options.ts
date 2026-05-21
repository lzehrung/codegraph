export type CacheModeOption = "off" | "memory" | "disk";

const CLI_VALUE_OPTIONS = new Set<string>([
  "--root",
  "--output",
  "--out",
  "--stderr-file",
  "--threads",
  "--native",
  "--cache",
  "--changed-since",
  "--git-base",
  "--git-head",
  "--symbols-detailed-scope",
  "--symbols-detailed-max-edges",
  "--sqlite",
  "--db",
  "--file",
  "--line",
  "--col",
  "--column",
  "--query",
  "--pattern",
  "--regex",
  "--glob",
  "--provider",
  "--base",
  "--head",
  "--pr",
  "--repo",
  "--max-refs",
  "--depth",
  "--sort",
  "--scope",
  "--ref-context",
  "--ref-context-lines",
  "--ref-block-max-lines",
  "--max-tests",
  "--max-callsites",
  "--language",
  "--min-tokens",
  "--max-tokens",
  "--max-bucket-size",
  "--min-confidence",
  "--max-hits",
  "--resolution-hint",
  "--review-depth",
  "--ignore-glob",
  "--include-glob",
  "--report-file",
  "--lcov",
  "--coverage-report",
  "--test-command-template",
  "--agent",
  "--target",
  "--limit",
  "--mode",
  "--from",
  "--max-dependencies",
  "--max-snippets",
  "--max-symbols",
  "--artifact",
  "--host",
  "--port",
]);

export function isCliValueOption(command: string, key: string, positionals: readonly string[]): boolean {
  if (command === "artifact" && key === "--sqlite" && positionals[0] === "build") return false;
  return CLI_VALUE_OPTIONS.has(key);
}

export function parseCacheModeOption(rawValue: string | undefined): CacheModeOption | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  if (rawValue === "off" || rawValue === "memory" || rawValue === "disk") {
    return rawValue;
  }
  throw new Error(`Invalid --cache value "${rawValue}". Expected one of: off, memory, disk.`);
}

function parseIntegerOptionValue(
  rawValue: string,
  optionName: string,
  expectedDescription: string,
  minValue: number,
  maxValue?: number,
): number {
  const parsedValue = Number(rawValue);
  const isAboveMinimum = parsedValue >= minValue;
  const isBelowMaximum = maxValue === undefined || parsedValue <= maxValue;
  if (!Number.isInteger(parsedValue) || !isAboveMinimum || !isBelowMaximum) {
    throw new Error(`Invalid ${optionName} value "${rawValue}". Expected ${expectedDescription}.`);
  }
  return parsedValue;
}

export function parsePositiveIntegerOption(
  rawValue: string | undefined,
  optionName: string,
  defaultValue: number,
): number {
  if (rawValue === undefined) {
    return defaultValue;
  }
  return parseIntegerOptionValue(rawValue, optionName, "a positive integer", 1);
}

export function parseOptionalPositiveIntegerOption(
  rawValue: string | undefined,
  optionName: string,
): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  return parseIntegerOptionValue(rawValue, optionName, "a positive integer", 1);
}

export function parseNonNegativeIntegerOption(
  rawValue: string | undefined,
  optionName: string,
  defaultValue: number,
): number {
  if (rawValue === undefined) {
    return defaultValue;
  }
  return parseIntegerOptionValue(rawValue, optionName, "a non-negative integer", 0);
}

export function parseOptionalNonNegativeIntegerOption(
  rawValue: string | undefined,
  optionName: string,
): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  return parseIntegerOptionValue(rawValue, optionName, "a non-negative integer", 0);
}

export function parseBoundedIntegerOption(
  rawValue: string | undefined,
  optionName: string,
  defaultValue: number,
  minValue: number,
  maxValue: number,
): number {
  if (rawValue === undefined) {
    return defaultValue;
  }
  return parseIntegerOptionValue(
    rawValue,
    optionName,
    `an integer from ${minValue} to ${maxValue}`,
    minValue,
    maxValue,
  );
}

export function parseOptionalBoundedIntegerOption(
  rawValue: string | undefined,
  optionName: string,
  minValue: number,
  maxValue: number,
): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  return parseIntegerOptionValue(
    rawValue,
    optionName,
    `an integer from ${minValue} to ${maxValue}`,
    minValue,
    maxValue,
  );
}
