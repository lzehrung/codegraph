import type { ImplicitReceiverRules, MemberUseSyntax } from "./receiver-syntax-types.js";

export const javaMemberUseSyntax: MemberUseSyntax = {
  callMemberType: "method_invocation",
  callReferenceTypes: { method_reference: true },
};

export const javaImplicitReceiverRules: ImplicitReceiverRules = {
  call: { nodeType: "method_invocation", calleeField: "name", receiverField: "object" },
  staticContext: true,
  namedMissHidesImports: true,
  staticMissChecksInstance: true,
};
