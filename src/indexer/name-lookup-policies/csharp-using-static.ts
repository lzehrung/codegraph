/**
 * C# `using static N.T;` (C# spec, "Using static directives"): a simple name that no enclosing
 * type or namespace member binds can name an accessible static member or nested type of `T`.
 * Extension methods are excluded because they are reached only through a receiver. Member
 * groups from several directives merge, and overloads are chosen by argument count only.
 */
import {
  callArgumentCount,
  declarationNodeIsStatic,
  nearestMemberContainer,
} from "../../graphs/symbol-graph-detailed/receiver-calls.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import { getCallableArity } from "../../languages/callable-arity.js";
import { normalizeCsharpIdentifier } from "../../util/identifiers.js";
import { fileIdentityKey } from "../../util/paths.js";
import { csharpNamespaceAt } from "../compilation-units.js";
import { isCsharpAccessibleOutsideType } from "../declaration-visibility.js";
import { okGoToResult } from "../navigation-provenance.js";
import type { BareNameUse, NameResolution } from "../name-resolution-types.js";
import type { ParsedFileContext } from "../parse-context.js";
import type { FileId } from "../../types.js";
import type { GoToResult, ModuleIndex, SymbolDef } from "../types.js";

/** A `using static` target: the declaring file and the owner's namespace and simple name. */
type UsingStaticImport = { file: FileId; namespace: string; typeName: string };

function usingStaticImports(mod: ModuleIndex): UsingStaticImport[] {
  const imports: UsingStaticImport[] = [];
  for (const imp of mod.imports) {
    if (imp.kind !== "star" || !imp.staticMembersOf || typeof imp.resolved !== "string") continue;
    const separator = imp.staticMembersOf.lastIndexOf(".");
    imports.push({
      file: imp.resolved,
      namespace: imp.staticMembersOf.slice(0, separator),
      typeName: imp.staticMembersOf.slice(separator + 1),
    });
  }
  return imports;
}

/** Files the lookup reads: the declaring file of every `using static` type. */
export function csharpUsingStaticFiles(mod: ModuleIndex): FileId[] {
  return usingStaticImports(mod).map((imp) => imp.file);
}

const NESTED_TYPE_DECLARATIONS = new Set([
  "class_declaration",
  "struct_declaration",
  "record_declaration",
  "interface_declaration",
  "enum_declaration",
  "delegate_declaration",
]);

/** The member declaration a definition names; a field's name sits in a variable declarator. */
function declarationOf(parsed: ParsedFileContext, def: SymbolDef): SyntaxNodeLike | null {
  const start = def.range.start.index;
  if (start === undefined) return null;
  const named = parsed.tree.rootNode.descendantForIndex(start, def.range.end.index ?? start).parent;
  return named?.type === "variable_declarator" ? (named.parent?.parent ?? null) : named;
}

/** The first parameter carries `this`: an extension method, not importable as a simple name. */
function isExtensionMethod(declaration: SyntaxNodeLike): boolean {
  const first = declaration.childForFieldName("parameters")?.namedChildren[0];
  return !!first?.namedChildren.some((child) => child.type === "modifier" && child.text === "this");
}

/**
 * Whether `declaration` is a member `using static` imports from the top-level type the directive
 * names. One file can declare `P.Util` and `Q.Util`, so the owner's namespace must match too.
 */
function importsMember(
  use: BareNameUse,
  parsed: ParsedFileContext,
  declaration: SyntaxNodeLike,
  imp: UsingStaticImport,
): boolean {
  const container = nearestMemberContainer(declaration);
  if (!container || nearestMemberContainer(container)) return false;
  const ownerName = container.childForFieldName("name")?.text;
  if (!ownerName || normalizeCsharpIdentifier(ownerName) !== imp.typeName) return false;
  if (csharpNamespaceAt(use.index, imp.file, container.startIndex) !== imp.namespace) return false;
  if (!isCsharpAccessibleOutsideType(declaration)) return false;
  if (NESTED_TYPE_DECLARATIONS.has(declaration.type) || container.type === "enum_declaration") return true;
  if (isExtensionMethod(declaration)) return false;
  return (
    declarationNodeIsStatic(declaration, parsed.source) ||
    declaration.namedChildren.some((child) => child.type === "modifier" && child.text === "const")
  );
}

type Candidate = { def: SymbolDef; declaration: SyntaxNodeLike; source: string };

/**
 * Members named `name` imported by the module's `using static` directives, or `null` when a
 * declaring file is not parsed yet (the provider records the miss for a retry).
 */
function usingStaticCandidates(use: BareNameUse, name: string): Candidate[] | null {
  const candidates: Candidate[] = [];
  let complete = true;
  for (const imp of usingStaticImports(use.mod)) {
    const target = use.index.byFile.get(fileIdentityKey(imp.file));
    const matches = target?.locals.filter((local) => local.localName === name) ?? [];
    if (!matches.length) continue;
    const parsed = use.files.get(imp.file);
    if (!parsed) {
      complete = false;
      continue;
    }
    for (const def of matches) {
      const declaration = declarationOf(parsed, def);
      if (declaration && importsMember(use, parsed, declaration, imp)) {
        candidates.push({ def, declaration, source: parsed.source });
      }
    }
  }
  return complete ? candidates : null;
}

/** One candidate, or the unique one whose parameters accept the call's argument count. */
function selectCandidate(use: BareNameUse, candidates: readonly Candidate[]): SymbolDef | null {
  if (candidates.length === 1) return candidates[0]!.def;
  const call = use.node.parent;
  const argumentCount =
    call?.type === "invocation_expression" && call.childForFieldName("function")?.id === use.node.id
      ? callArgumentCount(call, use.parsed.source)
      : null;
  if (argumentCount === null) return null;
  const accepting = candidates.filter(({ declaration, source }) => {
    const arity = getCallableArity({ languageId: "csharp", source, declaration });
    return !!arity && argumentCount >= arity.minArgs && (arity.maxArgs === null || argumentCount <= arity.maxArgs);
  });
  return accepting.length === 1 ? accepting[0]!.def : null;
}

const sameDefinition = (left: SymbolDef, right: SymbolDef): boolean =>
  fileIdentityKey(left.file) === fileIdentityKey(right.file) && left.range.start.index === right.range.start.index;

/**
 * Combines the cross-module answer with `using static` members. A name that both a namespace
 * lookup and a `using static` member provide is ambiguous: this lookup does not rank them.
 */
export function withCsharpUsingStatic(
  use: BareNameUse,
  lookupName: string,
  resolved: GoToResult | null,
): NameResolution | null {
  const candidates = usingStaticCandidates(use, lookupName);
  if (!candidates?.length) return resolved;
  const selected = selectCandidate(use, candidates);
  if (resolved?.status === "ok") {
    if (selected && sameDefinition(selected, resolved.definition)) return resolved;
    return { status: "not_found", reason: "Ambiguous name: a namespace member and a using static member" };
  }
  if (!selected) return { status: "not_found", reason: "No unique using static member" };
  return okGoToResult(use.index, selected, { resolution: "import", confidence: "high" });
}
