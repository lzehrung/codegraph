export type ParsedRustImportStatement =
  | {
      kind: "member";
      from: string;
      imported: string;
      local: string;
    }
  | {
      kind: "module";
      from: string;
      local: string;
      isExternCrate: boolean;
    }
  | {
      kind: "star";
      from: string;
    };

export function parseRustImportStatement(
  stmtText: string,
): ParsedRustImportStatement | null {
  const trimmed = stmtText.trim();

  const modMatch = trimmed.match(/^mod\s+([A-Za-z_][\w]*)\s*;?$/);
  if (modMatch?.[1]) {
    return {
      kind: "module",
      from: modMatch[1],
      local: modMatch[1],
      isExternCrate: false,
    };
  }

  const externMatch = trimmed.match(
    /^extern\s+crate\s+([A-Za-z_][\w]*)(?:\s+as\s+([A-Za-z_][\w]*))?\s*;?$/,
  );
  if (externMatch?.[1]) {
    return {
      kind: "module",
      from: externMatch[1],
      local: externMatch[2] ?? externMatch[1],
      isExternCrate: true,
    };
  }

  const useMatch = trimmed.match(/^use\s+(.+?)\s*;?$/);
  const useBody = useMatch?.[1]?.trim();
  if (!useBody) return null;
  if (useBody.includes("{") || useBody.includes(",")) return null;

  const aliasMatch = useBody.match(/^(.*?)\s+as\s+([A-Za-z_][\w]*)$/);
  const rawPath = aliasMatch?.[1]?.trim() ?? useBody;
  const alias = aliasMatch?.[2];

  if (rawPath.endsWith("::*")) {
    return { kind: "star", from: rawPath };
  }

  const parts = rawPath.split("::").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) {
    const moduleName = parts[0];
    if (!moduleName) return null;
    return {
      kind: "module",
      from: moduleName,
      local: alias ?? moduleName,
      isExternCrate: false,
    };
  }

  const imported = parts[parts.length - 1];
  const from = parts.slice(0, -1).join("::");
  if (!imported || !from) return null;
  return {
    kind: "member",
    from,
    imported,
    local: alias ?? imported,
  };
}

export type ParsedCsharpUsingDirective = {
  from: string;
  alias?: string;
  isStatic: boolean;
};

export function parseCsharpUsingDirective(
  stmtText: string,
): ParsedCsharpUsingDirective | null {
  const trimmed = stmtText.trim();

  const aliasMatch = trimmed.match(
    /^(?:global\s+)?using\s+([A-Za-z_][\w]*)\s*=\s*([A-Za-z_][\w.]*)\s*;?$/,
  );
  if (aliasMatch?.[1] && aliasMatch[2]) {
    return {
      from: aliasMatch[2],
      alias: aliasMatch[1],
      isStatic: false,
    };
  }

  const staticMatch = trimmed.match(
    /^(?:global\s+)?using\s+static\s+([A-Za-z_][\w.]*)\s*;?$/,
  );
  if (staticMatch?.[1]) {
    return {
      from: staticMatch[1],
      isStatic: true,
    };
  }

  const plainMatch = trimmed.match(
    /^(?:global\s+)?using\s+([A-Za-z_][\w.]*)\s*;?$/,
  );
  if (!plainMatch?.[1]) return null;
  return {
    from: plainMatch[1],
    isStatic: false,
  };
}
