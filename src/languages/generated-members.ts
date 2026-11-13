import type { LanguageSupport } from "../languages.js";
import type { SymbolDef } from "../indexer/types.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "./types.js";

/**
 * The generated-member hook to run over `source`, or undefined when the language has none or the file lacks the text
 * every generating call contains, so a file that generates nothing costs no per-node call. A caller that already knows
 * whether the file may generate members passes it, and the source is not scanned again.
 */
export function generatedMembersIn(
  support: LanguageSupport,
  source: string,
  known?: boolean,
): LanguageSupport["generatedMembers"] {
  const hook = support.generatedMembers;
  if (!hook) return undefined;
  if (known !== undefined) return known ? hook : undefined;
  const marker = support.generatedMembersMarker;
  return !marker || source.includes(marker) ? hook : undefined;
}

/** Whether `def` is a method that a call generates (Ruby `attr_reader :name`), declared at its argument token. */
export function isGeneratedMember(support: LanguageSupport, tree: SyntaxTreeLike, def: SymbolDef): boolean {
  const hook = support.generatedMembers;
  const start = def.range.start.index;
  if (!hook || start === undefined) return false;
  let node: SyntaxNodeLike | null = tree.rootNode.descendantForIndex(start, start);
  for (; node; node = node.parent) {
    if (hook(node).some((member) => member.node.startIndex === start)) return true;
  }
  return false;
}

/**
 * In Ruby, a later `attr_*` replaces an earlier instance `def` of the same name in the same body (`def x; attr_reader
 * :x`). Remove any non-generated instance member that precedes a generated instance member of the same name.
 */
export function filterEarlierReplacedMembers<T>(
  support: LanguageSupport,
  tree: SyntaxTreeLike,
  items: T[],
  getDef: (item: T) => SymbolDef,
  isInstance: (item: T) => boolean,
): T[] {
  if (!support.generatedMembers || items.length < 2) return items;
  const latestGeneratedStartByName = new Map<string, number>();
  for (const item of items) {
    const def = getDef(item);
    const start = def.range.start.index;
    if (start === undefined || !isInstance(item) || !isGeneratedMember(support, tree, def)) continue;
    const prev = latestGeneratedStartByName.get(def.localName);
    if (prev === undefined || start > prev) latestGeneratedStartByName.set(def.localName, start);
  }
  if (!latestGeneratedStartByName.size) return items;
  return items.filter((item) => {
    const def = getDef(item);
    const latest = latestGeneratedStartByName.get(def.localName);
    if (latest === undefined || !isInstance(item)) return true;
    const start = def.range.start.index;
    if (start === undefined || start >= latest) return true;
    return isGeneratedMember(support, tree, def);
  });
}
