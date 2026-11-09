/**
 * `not_found` reasons that mean "more than one definition could be the target", not "nothing
 * binds this name". Reference coverage must treat such a use as unverified, because one of the
 * candidates may be the definition whose references are being collected.
 */
export const AMBIGUOUS_STAR_IMPORT_REASON = "Ambiguous star import";
export const AMBIGUOUS_CPP_OVERLOAD_REASON = "Ambiguous C++ overload";
export const AMBIGUOUS_CPP_USING_DECLARATION_REASON = "No unique C++ using-declaration target";
export const AMBIGUOUS_CPP_USING_DIRECTIVE_REASON = "No unique C++ using-directive target";
/** The name may bind through its qualifier, but a bare import cannot decide it. */
export const UNRESOLVED_QUALIFIED_TYPE_REASON = "Unresolved qualified type";
/** A proven namespace is not a reference to a same-spelled type or member. */
export const CSHARP_NAMESPACE_NAME_REASON = "C# name denotes a namespace, not an indexed symbol";
/**
 * A project base or partial type cannot be inspected, so an enclosing member may hide a using alias.
 */
export const UNPROVEN_CSHARP_ALIAS_MEMBER_REASON = "C# alias may be hidden by a member of an unresolved base type";
/** Enclosing members hide the alias, but arity and visibility do not prove one applicable declaration. */
export const AMBIGUOUS_CSHARP_ALIAS_MEMBER_REASON = "No unique applicable C# member before using alias";
/** An implicit receiver has multiple viable or unproven same-name member candidates. */
export const AMBIGUOUS_IMPLICIT_MEMBER_REASON = "No unique member through the implicit receiver";
/** A known receiver declares the name, but its members compete for the call or leave the target unproven. */
export const AMBIGUOUS_RECEIVER_MEMBER_REASON = "No unique receiver member";
/**
 * A known receiver declares the name, but none of its members accepts the call. The members hide the name from the
 * rest of the hierarchy, so the use is not a candidate for a hidden declaration (C++ `Derived::run` hiding
 * `Base::run`) and it is deliberately absent from the ambiguous reasons: reference coverage stays complete.
 */
export const INAPPLICABLE_RECEIVER_MEMBER_REASON = "No applicable receiver member";

const AMBIGUOUS_RESOLUTION_REASONS: ReadonlySet<string> = new Set([
  AMBIGUOUS_STAR_IMPORT_REASON,
  AMBIGUOUS_CPP_OVERLOAD_REASON,
  AMBIGUOUS_CPP_USING_DECLARATION_REASON,
  AMBIGUOUS_CPP_USING_DIRECTIVE_REASON,
  UNPROVEN_CSHARP_ALIAS_MEMBER_REASON,
  AMBIGUOUS_IMPLICIT_MEMBER_REASON,
  AMBIGUOUS_RECEIVER_MEMBER_REASON,
  AMBIGUOUS_CSHARP_ALIAS_MEMBER_REASON,
]);

export function isAmbiguousResolutionReason(reason: string | undefined): boolean {
  return reason !== undefined && AMBIGUOUS_RESOLUTION_REASONS.has(reason);
}
