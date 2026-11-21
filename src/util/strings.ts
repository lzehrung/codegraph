type StringComparator = (this: void, left: string, right: string) => number;
// ECMA-402's compare accessor returns a function already bound to its collator.
type BoundCollator = { readonly compare: StringComparator };
const englishCollator: BoundCollator = new Intl.Collator("en-US");
const englishStringCompare = englishCollator.compare;
const COLLATOR_OPTION_FIELDS = [
  "usage",
  "localeMatcher",
  "collation",
  "numeric",
  "caseFirst",
  "sensitivity",
  "ignorePunctuation",
] as const satisfies readonly (keyof Intl.CollatorOptions)[];

type CollatorOptionValue = Intl.CollatorOptions[keyof Intl.CollatorOptions];
type CollatorCacheNode = {
  values: Map<CollatorOptionValue, CollatorCacheNode>;
  compare?: StringComparator;
};
let collatorsByOptions: CollatorCacheNode | undefined;

/**
 * Public data order uses en-US collation, independent of the process locale.
 * Cache by scalar option values, so warm comparisons allocate neither collators nor temporary keys,
 * even when callers supply equivalent option objects with different identities or property order.
 */
export function compareStrings(left: string, right: string, options?: Intl.CollatorOptions): number {
  if (options === undefined) return englishStringCompare(left, right);
  let cached: CollatorCacheNode = (collatorsByOptions ??= { values: new Map() });
  let hasOptions = false;
  for (let index = 0; index < COLLATOR_OPTION_FIELDS.length; index++) {
    const field = COLLATOR_OPTION_FIELDS[index]!;
    const value = options[field];
    if (value !== undefined) hasOptions = true;
    let next = cached.values.get(value);
    if (!next) {
      next = { values: new Map() };
      cached.values.set(value, next);
    }
    cached = next;
  }
  if (!cached.compare) {
    const collator: BoundCollator = hasOptions ? new Intl.Collator("en-US", options) : englishCollator;
    cached.compare = collator.compare;
  }
  return cached.compare(left, right);
}

export function stringifyUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[Object]";
    }
  }
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") {
    return `[Function: ${value.name || "anonymous"}]`;
  }
  return "unknown";
}
