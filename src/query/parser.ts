import { type SymbolNodeKind } from "../graphs/symbol-graph.js";

export type SymbolQuery = {
  text?: string;
  nameIncludes?: string;
  fileIncludes?: string;
  docstringIncludes?: string;
  kinds?: SymbolNodeKind[];
};

export type GraphQuery =
  | { kind: "mostCalledMethods"; limit: number }
  | { kind: "dependencyChain"; className: string }
  | { kind: "controllersMostEndpoints"; limit: number }
  | { kind: "classesImplementing"; interfaceName: string }
  | { kind: "affectedFunctionsForModule"; modulePath: string }
  | { kind: "highestComplexityClasses"; limit: number }
  | { kind: "highestComplexityFunctions"; limit: number };

const tokenize = (input: string): string[] =>
  input.match(/[^\s"]+:"[^"]+"|"[^"]+"|\S+/g)?.map((token) => token.trim()) ?? [];

const normalizeToken = (token: string): string =>
  token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token;

export function parseSymbolQuery(input: string): SymbolQuery {
  const query: SymbolQuery = {};
  const residual: string[] = [];
  for (const raw of tokenize(input)) {
    const token = normalizeToken(raw);
    const idx = token.indexOf(":");
    if (idx <= 0) {
      if (token) residual.push(token);
      continue;
    }
    const key = token.slice(0, idx).toLowerCase();
    let value = token.slice(idx + 1);
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    if (key === "kind" || key === "kinds") {
      const kinds = value
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean) as SymbolNodeKind[];
      if (kinds.length) query.kinds = kinds;
      continue;
    }
    if (key === "name") {
      query.nameIncludes = value;
      continue;
    }
    if (key === "file") {
      query.fileIncludes = value;
      continue;
    }
    if (key === "doc" || key === "docstring") {
      query.docstringIncludes = value;
      continue;
    }
    residual.push(token);
  }
  if (residual.length) query.text = residual.join(" ");
  return query;
}

const normalizePhrase = (value: string): string =>
  value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^the\s+/i, "");

const parseLimit = (input: string, fallback: number): number => {
  const match = /(?:top|most)\s+(\d+)/i.exec(input);
  if (!match) return fallback;
  const limit = Number(match[1]);
  return Number.isFinite(limit) && limit > 0 ? limit : fallback;
};

export function parseGraphQuery(input: string): GraphQuery | null {
  const text = input.trim();
  const lower = text.toLowerCase();

  if (lower.includes("most called methods")) {
    return { kind: "mostCalledMethods", limit: parseLimit(text, 10) };
  }
  if (lower.includes("dependency chain")) {
    const match = /dependency chain for (.+?) class/i.exec(text);
    if (!match) return null;
    return {
      kind: "dependencyChain",
      className: normalizePhrase(match[1] ?? ""),
    };
  }
  if (lower.includes("controllers have the most endpoints")) {
    return { kind: "controllersMostEndpoints", limit: parseLimit(text, 10) };
  }
  if (lower.includes("implement") && lower.includes("interface")) {
    const match = /implement(?:s)? (.+?) interface/i.exec(text);
    if (!match) return null;
    return {
      kind: "classesImplementing",
      interfaceName: normalizePhrase(match[1] ?? ""),
    };
  }
  if (lower.includes("affected") && lower.includes("module")) {
    const match =
      /change (?:this )?module\s+["']?([^"']+)["']?/i.exec(text) ?? /module\s+["']?([^"']+)["']?/i.exec(text);
    if (!match) return null;
    return {
      kind: "affectedFunctionsForModule",
      modulePath: normalizePhrase(match[1] ?? ""),
    };
  }
  if (lower.includes("highest complexity") && lower.includes("function")) {
    return { kind: "highestComplexityFunctions", limit: parseLimit(text, 10) };
  }
  if (lower.includes("highest complexity")) {
    return { kind: "highestComplexityClasses", limit: parseLimit(text, 10) };
  }
  return null;
}
