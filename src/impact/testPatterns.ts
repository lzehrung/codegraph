import type { FileId } from "../types.js";

const DEFAULT_TEST_PATTERNS: readonly RegExp[] = [
  /(^|\/)__tests__(\/|$)/i,
  /(^|\/)test(s)?(\/|$)/i,
  /(^|\/)spec(s)?(\/|$)/i,
  /\.(test|spec)\.[^./]+$/i,
  /(^|\/)[^/]*[-_.](test|spec)\.[^./]+$/i,
];

export function compileTestPatterns(
  patterns: string[] | undefined,
  onInvalidPattern?: (pattern: string, error: Error) => void,
): RegExp[] {
  const out = [...DEFAULT_TEST_PATTERNS];
  for (const pattern of patterns ?? []) {
    try {
      out.push(new RegExp(pattern));
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      onInvalidPattern?.(pattern, normalized);
    }
  }
  return out;
}

export function isTestFilePath(file: FileId, patterns: RegExp[]): boolean {
  const normalized = file.replace(/\\/g, "/");
  return patterns.some((pattern) => pattern.test(normalized));
}
