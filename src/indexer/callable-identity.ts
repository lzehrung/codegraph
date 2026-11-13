import {
  CALLABLE_DECLARATION_NODE_TYPES,
  getCallableDeclarationFacts,
  type CallableArity,
  type CallableIdentity,
} from "../languages/callable-arity.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import type { SymbolDef } from "./types.js";
import {
  cppCallableHasInternalLinkage,
  cppCallableIsDefinition,
  cppCallableOwnerPath,
  cppCallableSignatureForNode,
} from "./cpp-callables.js";
import { typescriptCallableContainerKeyForNode, typescriptCallableRole } from "./ts-callables.js";
import { swiftCallableParameters } from "../util/swift-tree.js";

/** Facts a language's callable declaration carries beside its identity key: Swift external labels and defaults. */
const CALLABLE_FACT_EXTRACTORS: Readonly<Record<string, (declaration: SyntaxNodeLike) => Partial<CallableIdentity>>> = {
  swift: (declaration) => {
    const parameters = swiftCallableParameters(declaration);
    return parameters ? { swiftParameters: parameters } : {};
  },
};

function callableDeclaration(node: SyntaxNodeLike | undefined): SyntaxNodeLike | undefined {
  for (let current = node; current; current = current.parent ?? undefined) {
    if (
      CALLABLE_DECLARATION_NODE_TYPES[current.type] ||
      current.type === "function_signature" ||
      current.type === "method_signature" ||
      current.type === "call_signature" ||
      current.type === "abstract_method_signature"
    )
      return current;
    if (current.type === "program") break;
  }
  return undefined;
}

/** Only syntax and the declaring file are known here; imports and using-directives remain query-time facts. */
export function callableIdentityForDeclaration(args: {
  file: string;
  name: string;
  range: Range;
  languageId: string;
  source: string;
  node?: SyntaxNodeLike;
}): CallableIdentity {
  const { file, name, range, languageId, source, node } = args;
  const declaration = callableDeclaration(node);
  const facts = declaration ? getCallableDeclarationFacts({ languageId, source, declaration }) : null;
  const arity = facts?.arity ?? null;
  const kind = facts?.kind ?? "function";
  const uniqueKey = `${file}\0${name}\0${range.start.index ?? -1}\0${range.end.index ?? -1}`;
  const base = {
    kind,
    arity,
    ...(facts?.unboundArity ? { unboundArity: facts.unboundArity } : {}),
  };
  if (languageId === "c" || languageId === "cpp") {
    const signature = node ? cppCallableSignatureForNode(node, arity) : null;
    const owner = languageId === "cpp" && node ? cppCallableOwnerPath(node) : "";
    let key = uniqueKey;
    if (languageId === "c") key = `${file}\0${name}`;
    else if (signature) {
      const qualifiedSignature = `${owner}\0${name}\0${signature}`;
      key = node && cppCallableHasInternalLinkage(node) ? `${file}\0${qualifiedSignature}` : qualifiedSignature;
    }
    return {
      ...base,
      owner,
      key,
      ...(signature ? { signature } : {}),
      definition: !!node && cppCallableIsDefinition(node),
    };
  }
  if (languageId === "ts" || languageId === "tsx") {
    const owner = node ? typescriptCallableContainerKeyForNode(node) : "module";
    return { ...base, owner, key: node ? `${file}\0${owner}\0${name}` : uniqueKey, role: typescriptCallableRole(node) };
  }
  const languageFacts = CALLABLE_FACT_EXTRACTORS[languageId];
  if (languageFacts && declaration) return { ...base, owner: "", key: uniqueKey, ...languageFacts(declaration) };
  return { ...base, owner: "", key: uniqueKey };
}

/**
 * A method generated at an argument token (Ruby `attr_reader :name`) has no parameter list; the generator fixes how
 * many arguments it takes. The key has the shape of any declaration's, so two methods of one token stay distinct.
 */
export function callableIdentityForGeneratedMember(args: {
  file: string;
  name: string;
  range: Range;
  arity: number;
}): CallableIdentity {
  const { file, name, range, arity } = args;
  return {
    kind: "function",
    arity: { minArgs: arity, maxArgs: arity },
    owner: "",
    key: `${file}\0${name}\0${range.start.index ?? -1}\0${range.end.index ?? -1}`,
  };
}

/**
 * A C++ function first declared `static` keeps internal linkage when a later declaration in the
 * same file omits `static` (`static int run(); int run() {}`). One declaration node cannot see
 * that, so give every same-signature declaration in the file the static one's file-scoped key.
 */
export function propagateCppInternalLinkage(file: string, locals: readonly SymbolDef[]): void {
  const prefix = file + "\0";
  const internal = new Set<string>();
  for (const local of locals) {
    const callable = local.callable;
    if (callable?.signature && callable.key.startsWith(prefix)) internal.add(callable.key.slice(prefix.length));
  }
  if (!internal.size) return;
  for (const local of locals) {
    const callable = local.callable;
    if (callable?.signature && internal.has(callable.key)) local.callable = { ...callable, key: prefix + callable.key };
  }
}

/** Rebase file-scoped keys; external C++ signature keys have no file prefix. */
export function callableIdentityWithFile(
  callable: CallableIdentity,
  previousFile: string,
  file: string,
): CallableIdentity {
  if (previousFile === file) return callable;
  if (!callable.key.startsWith(previousFile) || callable.key.charCodeAt(previousFile.length) !== 0) return callable;
  return { ...callable, key: file + callable.key.slice(previousFile.length) };
}

function isArity(value: unknown): value is CallableArity {
  if (!value || typeof value !== "object") return false;
  const range = value as Partial<CallableArity>;
  return (
    Number.isSafeInteger(range.minArgs) &&
    range.minArgs! >= 0 &&
    (range.maxArgs === null || (Number.isSafeInteger(range.maxArgs) && range.maxArgs! >= range.minArgs!))
  );
}

/** Shared guard for both persisted module formats. */
export function isCallableIdentity(value: unknown): value is CallableIdentity {
  if (!value || typeof value !== "object") return false;
  const callable = value as Partial<CallableIdentity>;
  return (
    typeof callable.key === "string" &&
    !!callable.key &&
    typeof callable.owner === "string" &&
    (callable.kind === "function" ||
      callable.kind === "instance-method" ||
      callable.kind === "class-method" ||
      callable.kind === "static-method") &&
    (callable.arity === null || isArity(callable.arity)) &&
    (callable.unboundArity === undefined || isArity(callable.unboundArity)) &&
    (callable.swiftParameters === undefined ||
      (Array.isArray(callable.swiftParameters) &&
        callable.swiftParameters.every(
          (parameter) =>
            typeof parameter.label === "string" &&
            typeof parameter.optional === "boolean" &&
            typeof parameter.variadic === "boolean",
        ))) &&
    (callable.signature === undefined || typeof callable.signature === "string") &&
    (callable.role === undefined ||
      callable.role === "signature" ||
      callable.role === "implementation" ||
      callable.role === "other") &&
    (callable.definition === undefined || typeof callable.definition === "boolean")
  );
}

/** Whether the facts a language stores beside two callables' identities prove their signatures differ: Swift labels. */
export function callableFactsDiffer(left: CallableIdentity | undefined, right: CallableIdentity | undefined): boolean {
  const leftSwift = left?.swiftParameters;
  const rightSwift = right?.swiftParameters;
  if (!leftSwift && !rightSwift) return false;
  if (!leftSwift || !rightSwift || leftSwift.length !== rightSwift.length) return true;
  return leftSwift.some(
    (parameter, at) => parameter.label !== rightSwift[at]?.label || parameter.variadic !== rightSwift[at]?.variadic,
  );
}
