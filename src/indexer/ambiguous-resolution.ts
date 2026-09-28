/**
 * `not_found` reasons that mean "more than one definition could be the target", not "nothing
 * binds this name". Reference coverage must treat such a use as unverified, because one of the
 * candidates may be the definition whose references are being collected.
 */
export const AMBIGUOUS_STAR_IMPORT_REASON = "Ambiguous star import";
export const AMBIGUOUS_CPP_OVERLOAD_REASON = "Ambiguous C++ overload";
export const AMBIGUOUS_CPP_USING_DECLARATION_REASON = "No unique C++ using-declaration target";
export const AMBIGUOUS_CPP_USING_DIRECTIVE_REASON = "No unique C++ using-directive target";

const AMBIGUOUS_RESOLUTION_REASONS: ReadonlySet<string> = new Set([
  AMBIGUOUS_STAR_IMPORT_REASON,
  AMBIGUOUS_CPP_OVERLOAD_REASON,
  AMBIGUOUS_CPP_USING_DECLARATION_REASON,
  AMBIGUOUS_CPP_USING_DIRECTIVE_REASON,
]);

export function isAmbiguousResolutionReason(reason: string | undefined): boolean {
  return reason !== undefined && AMBIGUOUS_RESOLUTION_REASONS.has(reason);
}
