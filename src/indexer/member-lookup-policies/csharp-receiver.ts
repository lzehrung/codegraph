import type { ImplicitReceiverRules, MemberUseSyntax } from "./receiver-syntax-types.js";

const CALL = { nodeType: "invocation_expression", calleeField: "function" };
export const csharpMemberUseSyntax: MemberUseSyntax = { parentCall: CALL };
export const csharpImplicitReceiverRules: ImplicitReceiverRules = {
  call: CALL,
  staticContext: true,
  namedMissHidesImports: true,
};
