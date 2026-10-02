import {
  CALLABLE_DECLARATION_NODE_TYPES,
  getCallableDeclarationFacts,
  type CallableArity,
  type CallableIdentity,
} from "../languages/callable-arity.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import { cppCallableIsDefinition, cppCallableOwnerPath, cppCallableSignatureForNode } from "./cpp-callables.js";
import { typescriptCallableContainerKeyForNode, typescriptCallableRole } from "./ts-callables.js";

function callableDeclaration(node: SyntaxNodeLike | undefined): SyntaxNodeLike | undefined {
  for (let current = node; current; current = current.parent ?? undefined) {
    if (
      CALLABLE_DECLARATION_NODE_TYPES[current.type] ||
      current.type === "function_signature" ||
      current.type === "method_signature" ||
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
    else if (signature) key = `${owner}\0${name}\0${signature}`;
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
  return { ...base, owner: "", key: uniqueKey };
}

/** Rebase file-scoped keys; C++ signature keys deliberately have no file prefix. */
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
    (callable.signature === undefined || typeof callable.signature === "string") &&
    (callable.role === undefined ||
      callable.role === "signature" ||
      callable.role === "implementation" ||
      callable.role === "other") &&
    (callable.definition === undefined || typeof callable.definition === "boolean")
  );
}
