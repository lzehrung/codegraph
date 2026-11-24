import type { LanguageSpecificImportContext } from "./context.js";
import type { ImportBinding } from "../types.js";
import { GO_IDENTIFIER_SOURCE } from "../../util/identifiers.js";

export function normalizeGoImports(context: LanguageSpecificImportContext): void {
  const imports = context.getBindings();
  if (!imports.length) return;
  const aliasByFrom = new Map<string, string>();
  // Go alias is either the standalone dot-import token or a real Go identifier (Unicode
  // letter/underscore start, decimal-digit continuation); the blank identifier "_" is a
  // valid identifier already covered by GO_IDENTIFIER_SOURCE.
  const importPattern = new RegExp(
    String.raw`^\s*(?:import\s+)?(?:(?<alias>\.|${GO_IDENTIFIER_SOURCE})\s+)?["'\u0060](?<from>[^"'\u0060]+)["'\u0060]`,
    "gmu",
  );
  for (const match of context.source.matchAll(importPattern)) {
    const from = match.groups?.from;
    if (!from) continue;
    const alias = match.groups?.alias;
    if (alias) {
      aliasByFrom.set(from, alias);
    }
  }

  if (!aliasByFrom.size) {
    return;
  }

  const normalized: ImportBinding[] = [];
  const seen = new Set<string>();
  for (const imp of imports) {
    const alias = aliasByFrom.get(imp.from);
    let next: ImportBinding | null = imp;
    if (alias === ".") {
      next = {
        kind: "star",
        from: imp.from,
        ...(imp.resolved !== undefined ? { resolved: imp.resolved } : {}),
        ...(imp.typeOnly ? { typeOnly: imp.typeOnly } : {}),
      };
    } else if (alias === "_") {
      next = null;
    } else if (alias && imp.kind === "namespace") {
      next = {
        ...imp,
        localNS: alias,
      };
    }
    if (!next) continue;
    const key = JSON.stringify(next);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(next);
  }

  context.replaceBindings(normalized);
}
