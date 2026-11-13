/**
 * Per-language additions to the shared bare-name lookup order in `../name-resolution.ts`.
 * New lookup rules belong in a policy here, never in a consumer (go-to-definition, references,
 * or the detailed graph), so every consumer answers the same way.
 */
import { getCallArgumentCount } from "../../languages/callable-arity.js";
import { rustTokenTreeNameFollowsSeparator } from "../../util/member-access.js";
import { fileIdentityKey } from "../../util/paths.js";
import { okGoToResult } from "../navigation-provenance.js";
import { resolveImported } from "../navigation-resolve.js";
import { typescriptOverloadImplementationAcceptsCount } from "../ts-callables.js";
import { scopeIdentifierKey, scopeNodesFor } from "../scope-nodes.js";
import { type ModuleIndex, type SymbolDef, SymbolKind } from "../types.js";
import type { NameLookupPolicy } from "../name-resolution-types.js";
import type { Binding } from "../scope-types.js";
import { cLookupPolicy, cppLookupPolicy } from "./c-family.js";
import { csharpLookupPolicy, jvmLookupPolicy, kotlinLookupPolicy, swiftLookupPolicy } from "./implicit-self.js";
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

/** Go package aliases yield to closer local bindings. */
const goLookupPolicy: NameLookupPolicy = {
  moduleAliasIsUnshadowed: ({ use, closestBinding }) =>
    !closestBinding || use.scopeIndex.allScopes[0]?.map.get(closestBinding.canonicalName) === closestBinding,
};
/** A Zig declaration initialized from an imported member names the source symbol. */
const zigLookupPolicy: NameLookupPolicy = {
  onLocal({ use, lookupName }, local) {
    const binding = use.mod.imports.find(
      (candidate) =>
        candidate.kind === "named" &&
        candidate.local === lookupName &&
        candidate.localRange?.start.index === local.range.start.index &&
        fileIdentityKey(local.file) === fileIdentityKey(use.file),
    );
    if (!binding || binding.kind !== "named") return undefined;
    const target = resolveImported(use.index, binding, binding.imported);
    if (!target || "namespace" in target) return { status: "not_found", reason: "Unresolved Zig symbol import" };
    return okGoToResult(use.index, target, {
      via: {
        ...(typeof binding.resolved === "string" ? { importedFrom: binding.resolved } : {}),
        exportedName: binding.imported,
      },
      resolution: "import",
      confidence: "high",
    });
  },
};

/**
 * Ruby: a generated method (`attr_reader :name`) is named by a bare use only through the scope binding that checks where
 * the use sits. The same-file fallback below it would bind the method from any class declared after it. When an earlier
 * `def` is replaced by a later `attr_*`, that `def`'s own declaration token still names itself, never the later accessor.
 */
const rubyLookupPolicy: NameLookupPolicy = {
  fromClosestBinding({ use, closestBinding }) {
    if (!use.scopeIndex.hasGeneratedMembers || !closestBinding?.generatedOwner) return undefined;
    const { node, file } = use;
    for (
      let binding: Binding | undefined = closestBinding.earlierSameScope;
      binding;
      binding = binding.earlierSameScope
    ) {
      if (binding.generatedOwner) continue;
      if (binding.node?.startIndex !== node.startIndex || binding.node.endIndex !== node.endIndex) continue;
      const def = use.mod.locals.find(
        (local) =>
          fileIdentityKey(local.file) === fileIdentityKey(file) &&
          local.range.start.index === node.startIndex &&
          local.range.end.index === node.endIndex,
      );
      return def ? okGoToResult(use.index, def, { resolution: "exact", confidence: "high" }) : undefined;
    }
    return undefined;
  },
  afterCrossModule({ use, lookupName }, resolved) {
    if (resolved?.status !== "ok") return undefined;
    if (!use.scopeIndex.hasGeneratedMembers) return undefined;
    const { definition } = resolved;
    if (fileIdentityKey(definition.file) !== fileIdentityKey(use.file)) return undefined;
    const sup = use.parsed.sup;
    const key = scopeIdentifierKey(scopeNodesFor(sup.id), lookupName, use.node, sup.normalizeIdentifier);
    const generated = use.scopeIndex.bindings
      .get(key)
      ?.some((binding) => binding.generatedOwner && binding.def?.start.index === definition.range.start.index);
    return generated ? null : undefined;
  },
};
const NO_POLICY: NameLookupPolicy = {};

const POLICIES: Readonly<Record<string, NameLookupPolicy>> = {
  c: cLookupPolicy,
  cpp: cppLookupPolicy,
  csharp: csharpLookupPolicy,
  java: jvmLookupPolicy,
  go: goLookupPolicy,
  kotlin: kotlinLookupPolicy,
  php: phpLookupPolicy,
  python: pythonLookupPolicy,
  ruby: rubyLookupPolicy,
  rust: rustLookupPolicy,
  swift: swiftLookupPolicy,
  ts: typescriptLookupPolicy,
  tsx: typescriptLookupPolicy,
  zig: zigLookupPolicy,
};

export function nameLookupPolicyFor(languageId: string): NameLookupPolicy {
  return POLICIES[languageId] ?? NO_POLICY;
}
