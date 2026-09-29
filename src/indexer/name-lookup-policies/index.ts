/**
 * Per-language additions to the shared bare-name lookup order in `../name-resolution.ts`.
 * New lookup rules belong in a policy here, never in a consumer (go-to-definition, references,
 * or the detailed graph), so every consumer answers the same way.
 */
import { getCallArgumentCount } from "../../languages/callable-arity.js";
import { rustTokenTreeNameFollowsSeparator } from "../../util/member-access.js";
import { fileIdentityKey } from "../../util/paths.js";
import { resolveImported } from "../navigation-resolve.js";
import { typescriptOverloadImplementationAcceptsCount } from "../ts-callables.js";
import { type ModuleIndex, type SymbolDef, SymbolKind } from "../types.js";
import type { NameLookupPolicy } from "../name-resolution-types.js";
import { cLookupPolicy, cppLookupPolicy } from "./c-family.js";
import { csharpLookupPolicy, jvmLookupPolicy, swiftLookupPolicy } from "./implicit-self.js";
import { phpLookupPolicy } from "./php.js";

/** Whether a function shares its name with another function in its file (an overload set). */
function hasSameNameSiblings(module: ModuleIndex, def: SymbolDef): boolean {
  return module.locals.some(
    (candidate) =>
      candidate.kind === def.kind &&
      candidate.localName === def.localName &&
      candidate.range.start.index !== def.range.start.index,
  );
}

/** TypeScript overloads: a call must match a signature of the implementation it names. */
const typescriptLookupPolicy: NameLookupPolicy = {
  onUnboundLocal({ use, closestBinding }) {
    if (closestBinding?.kind !== "function" || use.node.parent?.type !== "call_expression") return undefined;
    return { status: "not_found", reason: "No matching TypeScript overload signature" };
  },
  afterCrossModule({ use }, resolved) {
    const call = use.node.parent;
    if (call?.type !== "call_expression" || resolved?.status !== "ok") return undefined;
    const target = resolved.definition;
    if (target.kind !== SymbolKind.Function) return undefined;
    const argumentCount = getCallArgumentCount({ languageId: use.parsed.sup.id, source: use.parsed.source, call });
    const targetModule = use.index.byFile.get(fileIdentityKey(target.file));
    // Only an overload set needs the target's syntax; a single implementation accepts any count.
    if (argumentCount === null || !targetModule || !hasSameNameSiblings(targetModule, target)) return undefined;
    const targetContext = use.files.get(target.file);
    if (!targetContext || (targetContext.sup.id !== "ts" && targetContext.sup.id !== "tsx")) return undefined;
    const accepted = typescriptOverloadImplementationAcceptsCount({
      implementation: target,
      locals: targetModule.locals,
      tree: targetContext.tree,
      source: targetContext.source,
      languageId: targetContext.sup.id,
      argumentCount,
    });
    return accepted ? undefined : { status: "not_found", reason: "No matching TypeScript overload signature" };
  },
  // A re-exported overload set lives in another file than the module the import names.
  *preloadFiles(index, mod) {
    for (const imp of mod.imports) {
      if (imp.kind !== "named" && imp.kind !== "default") continue;
      const target = resolveImported(index, imp, imp.kind === "default" ? "default" : imp.imported);
      if (!target || "namespace" in target) continue;
      const targetModule = index.byFile.get(fileIdentityKey(target.file));
      if (targetModule && hasSameNameSiblings(targetModule, target)) yield target.file;
    }
  },
};

/** Python: a module object is not callable. */
const pythonLookupPolicy: NameLookupPolicy = {
  afterCrossModule({ use }, resolved) {
    if (use.node.parent?.type !== "call" || resolved?.status !== "ok") return undefined;
    if (resolved.provenance?.resolution !== "namespace") return undefined;
    // A namespace binding holds a module object: the call is an error, not a call to the
    // module's first export.
    return { status: "not_found", reason: "No callable definition for a Python module binding" };
  },
};

/** Rust: macro arguments stay unparsed token trees. */
const rustLookupPolicy: NameLookupPolicy = {
  // A name preceded by `.` or `::` there is a member or path receiver the raw tokens cannot
  // prove, so bare-name resolution would answer with an unrelated same-named free function.
  beforeLexical(use) {
    if (!rustTokenTreeNameFollowsSeparator(use.node)) return undefined;
    return { status: "not_found", reason: "No resolvable receiver inside a Rust macro token tree" };
  },
};

const NO_POLICY: NameLookupPolicy = {};

const POLICIES: Readonly<Record<string, NameLookupPolicy>> = {
  c: cLookupPolicy,
  cpp: cppLookupPolicy,
  csharp: csharpLookupPolicy,
  java: jvmLookupPolicy,
  kotlin: jvmLookupPolicy,
  php: phpLookupPolicy,
  python: pythonLookupPolicy,
  rust: rustLookupPolicy,
  swift: swiftLookupPolicy,
  ts: typescriptLookupPolicy,
  tsx: typescriptLookupPolicy,
};

export function nameLookupPolicyFor(languageId: string): NameLookupPolicy {
  return POLICIES[languageId] ?? NO_POLICY;
}
