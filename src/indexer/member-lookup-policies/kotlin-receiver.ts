import type { CallableArity } from "../../languages/callable-arity.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import { AMBIGUOUS_RECEIVER_MEMBER_REASON } from "../ambiguous-resolution.js";
import type { ReceiverHooks } from "./types.js";
import type { ImplicitReceiverRules, MemberUseSyntax } from "./receiver-syntax-types.js";

const CALL = { nodeType: "call_expression", calleeNamedIndex: 0 };
export const kotlinMemberUseSyntax: MemberUseSyntax = {
  parentCall: CALL,
  openReferenceTypes: { callable_reference: true },
  openSeparator: "::",
};
export const kotlinImplicitReceiverRules: ImplicitReceiverRules = {
  call: CALL,
  references: { callable_reference: true },
  staticContext: true,
  staticMissChecksInstance: true,
};
/** A Kotlin property is invokable when its declared function type or initializer proves it. */
export function kotlinPropertyInvocationArity(nameNode: SyntaxNodeLike): CallableArity | null | undefined {
  const variable = nameNode.parent;
  if (variable?.type !== "variable_declaration" || variable.parent?.type !== "property_declaration") return undefined;
  const type = variable.namedChildren.find((child) => child.type === "function_type");
  const parameters = type?.namedChildren.find((child) => child.type === "function_type_parameters");
  if (parameters) {
    const count = parameters.namedChildren.length;
    return { minArgs: count, maxArgs: count };
  }
  const initializer = variable.parent.namedChildren.find((child) => child !== variable);
  if (initializer?.type === "callable_reference") return null;
  if (initializer?.type !== "lambda_literal") return undefined;
  const lambdaParameters = initializer.namedChildren.find((child) => child.type === "lambda_parameters");
  if (!lambdaParameters) return null;
  const count = lambdaParameters.namedChildren.length;
  return { minArgs: count, maxArgs: count };
}

export const kotlinReceiverHooks: ReceiverHooks = {
  implicit: kotlinImplicitReceiverRules,
  memberUse: kotlinMemberUseSyntax,
  callablePropertyArity: kotlinPropertyInvocationArity,
  namedOwnMemberMissReason: AMBIGUOUS_RECEIVER_MEMBER_REASON,
  trailingLambdaCalls: true,
  lambdaReceiverThis: true,
  access: { typeNameType: "user_type", unitPeerNames: true },
};
