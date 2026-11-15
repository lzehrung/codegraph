/** C# additions to member navigation and to reference coverage. */
import { AMBIGUOUS_CSHARP_ATTRIBUTE_REASON } from "../ambiguous-resolution.js";
import type { MemberLookupPolicy } from "./types.js";

export const csharpMemberLookupPolicy: MemberLookupPolicy = {
  // An attribute name that matches a class with and without the `Attribute` suffix is not a reference of either, but
  // either may be the one the author meant, wherever the use sits.
  unprovenReference: (_node, reason) => reason === AMBIGUOUS_CSHARP_ATTRIBUTE_REASON,
};
