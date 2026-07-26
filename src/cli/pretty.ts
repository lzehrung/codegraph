type PrettyOutputContext = {
  hasFlag: (name: string) => boolean;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
};

type PrettyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PrettyRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function formatLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value || "(empty)";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return String(value);
}

function appendRecord(lines: string[], value: PrettyRecord, indent: string): void {
  const entries = Object.entries(value);
  if (!entries.length) {
    lines.push(`${indent}(none)`);
    return;
  }
  for (const [key, item] of entries) {
    const label = formatLabel(key);
    if (Array.isArray(item) || isRecord(item)) {
      lines.push(`${indent}${label}:`);
      appendValue(lines, item, `${indent}  `);
    } else {
      lines.push(`${indent}${label}: ${formatScalar(item)}`);
    }
  }
}

function appendArray(lines: string[], values: readonly unknown[], indent: string): void {
  if (!values.length) {
    lines.push(`${indent}(none)`);
    return;
  }
  for (const value of values) {
    if (isRecord(value)) {
      const entries = Object.entries(value);
      const firstScalar = entries.find(([, item]) => !Array.isArray(item) && !isRecord(item));
      if (!firstScalar) {
        lines.push(`${indent}-`);
        appendRecord(lines, value, `${indent}  `);
        continue;
      }
      const [firstKey, firstValue] = firstScalar;
      lines.push(`${indent}- ${formatLabel(firstKey)}: ${formatScalar(firstValue)}`);
      const remaining = Object.fromEntries(entries.filter(([key]) => key !== firstKey));
      if (Object.keys(remaining).length) appendRecord(lines, remaining, `${indent}  `);
      continue;
    }
    if (Array.isArray(value)) {
      lines.push(`${indent}-`);
      appendArray(lines, value, `${indent}  `);
      continue;
    }
    lines.push(`${indent}- ${formatScalar(value)}`);
  }
}

function appendValue(lines: string[], value: unknown, indent: string): void {
  if (Array.isArray(value)) {
    appendArray(lines, value, indent);
  } else if (isRecord(value)) {
    appendRecord(lines, value, indent);
  } else {
    lines.push(`${indent}${formatScalar(value)}`);
  }
}

export function formatPrettyValue(value: unknown): string {
  const lines: string[] = [];
  appendValue(lines, value, "");
  return lines.join("\n");
}

export function writeCliOutput<T>(context: PrettyOutputContext, value: T, format?: (value: T) => string): void {
  if (context.hasFlag("--json")) {
    context.writeJSONLine(value);
    return;
  }
  context.writeStdoutLine(format ? format(value) : formatPrettyValue(value));
}
