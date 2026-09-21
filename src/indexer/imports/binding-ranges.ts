import { maskTrivia } from "../../util/trivia.js";
import { collectLineStartOffsets, positionAtOffset } from "../../util/lines.js";
import type { Range } from "../../types.js";
import type { ImportBinding } from "../import-types.js";

type NamedRangeField = "importedRange" | "localRange";

type RoleSlot = {
  bindingIndex: number;
  field: NamedRangeField;
  name: string;
};

/** Masks non-code text while preserving every UTF-16 offset used for range attribution. */
export function maskImportBindingTrivia(text: string, languageId: string): string {
  return maskTrivia(text, languageId);
}

/**
 * Attaches `importedRange`/`localRange` to "named" {@link ImportBinding} entries a producer
 * builds from parsed statement/clause text rather than per-token native captures: native
 * statement overrides (Java/Kotlin/C#/Rust/PHP, in `language-specific.ts`), Python's
 * `from ... import ...` clause, Swift's dotted symbol import, and CommonJS destructured
 * `require()` bindings. Direct JS/TS native captures already carry exact node ranges from
 * `native-captures.ts`'s standard-binding path (`pushStandardBindings`) and never reach this
 * function.
 *
 * Every unranged "named" binding in `[fromIndex, end)` contributes its expected source tokens
 * to one flat role sequence in source order: `[imported, local]` for ordinary aliases and
 * `[local, imported]` for C#'s `using Alias = Namespace.Path;`. An explicit alias remains two
 * slots even when both tokens have the same spelling. Only a truly unaliased binding with
 * `local === imported` collapses to one shared token.
 *
 * The whole sequence is then matched against `text` back to front: the last slot's token must
 * occur, as an exact whole word, somewhere in `text`; the second-to-last slot's token must
 * occur, as an exact whole word, strictly before that match; and so on. This proves every slot
 * against the true text order in one pass, without per-name occurrence counts or a leaf/alias
 * search-direction split -- both of which could still assign a binding's `imported` token to a
 * *different* binding's `local` token whenever the two literal spellings coincided (e.g.
 * `use a::{Bar as X, Baz as Bar}`, where the first binding's `imported` is "Bar" and the second
 * binding's `local` is also "Bar"). A qualified path's non-final segments repeating the leaf's
 * own spelling (e.g. Java `import com.Bar.Bar;`) is handled the same way: matching from the end
 * naturally lands on the last, real occurrence.
 *
 * If the complete sequence cannot be proven -- any single slot's token is missing before the
 * already-matched, more-rightward slots -- nothing in this batch is attributed. A partial match
 * would still risk assigning at least one wrong position, so the whole batch fails closed
 * together rather than individually.
 */
export function attributeNamedBindingRanges(args: {
  bindings: ImportBinding[];
  fromIndex: number;
  text: string;
  textStartIndex: number;
  source: string;
  /**
   * True only for producers whose "unaliased" binding can still encode two distinct source
   * tokens sharing the same spelling (currently just C#'s `using Alias = Namespace.Path;`).
   * Every other producer's `local === imported` really means "one token, no alias".
   */
  alwaysAliased?: boolean | undefined;
}): void {
  const { bindings, fromIndex, text, textStartIndex, source, alwaysAliased } = args;
  const slots = buildRoleSlots(bindings, fromIndex, alwaysAliased);
  if (!slots.length) return;

  const matches = matchRoleSequenceBackward(text, slots);
  if (!matches) return;

  const lineStarts = collectLineStartOffsets(source);

  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index]!;
    const binding = bindings[slot.bindingIndex]!;
    if (binding.kind !== "named") continue;
    const range = toSourceRange(lineStarts, textStartIndex, matches[index]!);
    binding[slot.field] = range;
    if (
      slot.field === "importedRange" &&
      binding.local === binding.imported &&
      !binding.explicitAlias &&
      binding.localRange === undefined
    ) {
      binding.localRange = range;
    }
  }
}

function buildRoleSlots(bindings: ImportBinding[], fromIndex: number, alwaysAliased: boolean | undefined): RoleSlot[] {
  const slots: RoleSlot[] = [];
  for (let index = fromIndex; index < bindings.length; index++) {
    const binding = bindings[index]!;
    if (binding.kind !== "named") continue;
    if (binding.importedRange !== undefined || binding.localRange !== undefined) continue;
    if (alwaysAliased) {
      slots.push({ bindingIndex: index, field: "localRange", name: binding.local });
      slots.push({ bindingIndex: index, field: "importedRange", name: binding.imported });
    } else if (binding.local === binding.imported && !binding.explicitAlias) {
      slots.push({ bindingIndex: index, field: "importedRange", name: binding.imported });
    } else {
      slots.push({ bindingIndex: index, field: "importedRange", name: binding.imported });
      slots.push({ bindingIndex: index, field: "localRange", name: binding.local });
    }
  }
  return slots;
}

/**
 * Matches every slot's token as an exact whole word in `text`, back to front: each match must
 * end at or before the start of the match already found for the next (more rightward) slot.
 * Returns `null`, proving nothing, the moment any single slot cannot be matched within its
 * remaining window.
 */
function matchRoleSequenceBackward(text: string, slots: RoleSlot[]): Array<{ start: number; end: number }> | null {
  const matches: Array<{ start: number; end: number } | null> = new Array(slots.length).fill(null);
  let upperBound = text.length;
  for (let index = slots.length - 1; index >= 0; index--) {
    const match = findRightmostWholeWordOccurrence(text, slots[index]!.name, upperBound);
    if (!match) return null;
    matches[index] = match;
    upperBound = match.start;
  }
  return matches as Array<{ start: number; end: number }>;
}

// A broad Unicode word-continuation check using the canonical ID_Continue property (covers
// combining marks, connector punctuation, and every other continuation category, not just
// letters/digits/underscore) plus the extra sigils some supported languages allow inside an
// identifier (`$` for ECMAScript, `@` for a C# verbatim-identifier prefix). False positives
// here only make the boundary test stricter (a real match gets skipped rather than a
// partial-identifier match getting accepted), which is the safe direction for a fail-closed
// attribution path.
const IDENTIFIER_CONTINUATION_PATTERN = /[\p{ID_Continue}$@]/u;

/**
 * True when the character immediately before `index` in `text` is an identifier-continuation
 * character, treating a UTF-16 surrogate pair as one code point rather than two lone
 * surrogates. Touches only the one or two code units nearest `index` -- never scans or
 * allocates a prefix -- so an astral (non-BMP) identifier character adjacent to a candidate
 * match is still recognized instead of silently reading as two invalid lone surrogates that
 * fail every `\p{ID_Continue}` test and get treated as a boundary.
 */
function isIdentifierContinuationBefore(text: string, index: number): boolean {
  if (index <= 0) return false;
  let charIndex = index - 1;
  const code = text.charCodeAt(charIndex);
  if (code >= 0xdc00 && code <= 0xdfff && charIndex > 0) {
    const highCode = text.charCodeAt(charIndex - 1);
    if (highCode >= 0xd800 && highCode <= 0xdbff) charIndex -= 1;
  }
  const codePoint = text.codePointAt(charIndex);
  return codePoint !== undefined && IDENTIFIER_CONTINUATION_PATTERN.test(String.fromCodePoint(codePoint));
}

/** Same code-point awareness as {@link isIdentifierContinuationBefore}, for the character
 * starting at `index`; `String.prototype.codePointAt` already combines a leading surrogate
 * pair on its own, so this side needs no adjustment. */
function isIdentifierContinuationAt(text: string, index: number): boolean {
  if (index >= text.length) return false;
  const codePoint = text.codePointAt(index);
  return codePoint !== undefined && IDENTIFIER_CONTINUATION_PATTERN.test(String.fromCodePoint(codePoint));
}

function isWholeWordMatchAt(text: string, start: number, word: string): boolean {
  if (isIdentifierContinuationBefore(text, start)) return false;
  if (isIdentifierContinuationAt(text, start + word.length)) return false;
  return true;
}

/** The rightmost exact whole-word occurrence of `word` in `text` that ends at or before
 * `beforeIndex`, or `null` if none exists in that window. */
function findRightmostWholeWordOccurrence(
  text: string,
  word: string,
  beforeIndex: number,
): { start: number; end: number } | null {
  if (!word) return null;
  let best: { start: number; end: number } | null = null;
  let searchFrom = 0;
  for (;;) {
    const start = text.indexOf(word, searchFrom);
    if (start === -1) break;
    const end = start + word.length;
    if (end > beforeIndex) break;
    searchFrom = start + 1;
    if (isWholeWordMatchAt(text, start, word)) best = { start, end };
  }
  return best;
}

function toSourceRange(
  lineStarts: readonly number[],
  textStartIndex: number,
  match: { start: number; end: number },
): Range {
  return sourceRangeFromOffsets(lineStarts, textStartIndex + match.start, textStartIndex + match.end);
}

export function sourceRangeFromOffsets(lineStarts: readonly number[], startIndex: number, endIndex: number): Range {
  return {
    start: positionAtOffset(lineStarts, startIndex),
    end: positionAtOffset(lineStarts, endIndex),
  };
}
