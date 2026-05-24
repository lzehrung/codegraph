export type AgentSymbolHandle = {
  file: string;
  name: string;
  line: number;
  column: number;
};

export type AgentSqlHandle = {
  name: string;
  file: string;
  line: number;
};

export type AgentFileHandle = {
  file: string;
};

export type AgentChunkHandle = {
  file: string;
  line: number;
};

export function formatAgentSymbolHandle(handle: AgentSymbolHandle): string {
  return [
    "symbol",
    encodeURIComponent(handle.file),
    encodeURIComponent(handle.name),
    String(handle.line),
    String(handle.column),
  ].join(":");
}

export function parseAgentSymbolHandle(handle: string): AgentSymbolHandle | null {
  if (!handle.startsWith("symbol:")) return null;
  const parts = handle.split(":");
  if (parts.length !== 5) return null;
  const file = decodeHandlePart(parts[1]);
  const name = decodeHandlePart(parts[2]);
  const line = Number(parts[3]);
  const column = Number(parts[4]);
  if (!file || !name || !Number.isFinite(line) || !Number.isFinite(column)) return null;
  return {
    file,
    name,
    line,
    column,
  };
}

export function formatAgentFileHandle(handle: AgentFileHandle): string {
  return ["file", encodeURIComponent(handle.file)].join(":");
}

function parseAgentFileLikeHandle(handle: string, prefix: "file" | "graph"): AgentFileHandle | null {
  const handlePrefix = `${prefix}:`;
  if (!handle.startsWith(handlePrefix)) return null;
  const encodedFile = handle.slice(handlePrefix.length);
  const file = decodeHandlePart(encodedFile) ?? encodedFile;
  if (!file) return null;
  return { file };
}

export function parseAgentFileHandle(handle: string): AgentFileHandle | null {
  return parseAgentFileLikeHandle(handle, "file");
}

export function formatAgentChunkHandle(handle: AgentChunkHandle): string {
  return ["chunk", encodeURIComponent(handle.file), String(handle.line)].join(":");
}

export function parseAgentChunkHandle(handle: string): AgentChunkHandle | null {
  if (!handle.startsWith("chunk:")) return null;
  const remainder = handle.slice("chunk:".length);
  const separator = remainder.lastIndexOf(":");
  if (separator < 0) return null;
  const encodedFile = remainder.slice(0, separator);
  const line = Number(remainder.slice(separator + 1));
  const file = decodeHandlePart(encodedFile) ?? encodedFile;
  if (!file || !Number.isFinite(line)) return null;
  return { file, line };
}

export function formatAgentGraphHandle(handle: AgentFileHandle): string {
  return ["graph", encodeURIComponent(handle.file)].join(":");
}

export function parseAgentGraphHandle(handle: string): AgentFileHandle | null {
  return parseAgentFileLikeHandle(handle, "graph");
}

export function formatAgentSqlHandle(handle: AgentSqlHandle): string {
  return ["sql", encodeURIComponent(handle.name), encodeURIComponent(handle.file), String(handle.line)].join(":");
}

export function parseAgentSqlHandle(handle: string): AgentSqlHandle | null {
  if (!handle.startsWith("sql:")) return null;
  const parts = handle.split(":");
  if (parts.length === 4) {
    const name = decodeHandlePart(parts[1]);
    const file = decodeHandlePart(parts[2]);
    const line = Number(parts[3]);
    if (!name || !file || !Number.isFinite(line)) return null;
    return { name, file, line };
  }

  if (parts.length > 4) {
    const name = parts[1];
    const file = parts.slice(2, -1).join(":");
    const line = Number(parts[parts.length - 1]);
    if (!name || !file || !Number.isFinite(line)) return null;
    return { name, file, line };
  }

  return null;
}

function decodeHandlePart(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
