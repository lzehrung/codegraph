export type CacheModeOption = "off" | "memory" | "disk";

export function parseCacheModeOption(rawValue: string | undefined): CacheModeOption | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  if (rawValue === "off" || rawValue === "memory" || rawValue === "disk") {
    return rawValue;
  }
  throw new Error(`Invalid --cache value "${rawValue}". Expected one of: off, memory, disk.`);
}

export function parsePositiveIntegerOption(
  rawValue: string | undefined,
  optionName: string,
  defaultValue: number,
): number {
  if (rawValue === undefined) {
    return defaultValue;
  }
  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    throw new Error(`Invalid ${optionName} value "${rawValue}". Expected a positive integer.`);
  }
  return parsedValue;
}
