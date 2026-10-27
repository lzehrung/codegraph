export function appendToArrayMap<TKey, TValue>(map: Map<TKey, TValue[]>, key: TKey, value: TValue): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  map.set(key, [value]);
}

export function uniqueByKey<T>(items: Iterable<T>, keyFor: (item: T) => string): T[] {
  const unique: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
export function createUnionFind(size: number): {
  find: (start: number) => number;
  unite: (left: number, right: number) => void;
} {
  const parent = Array.from({ length: size }, (_, index) => index);
  const find = (start: number): number => {
    let current = start;
    while (parent[current] !== current) {
      const parentIndex = parent[current]!;
      parent[current] = parent[parentIndex] ?? parentIndex;
      current = parentIndex;
    }
    return current;
  };
  const unite = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  return { find, unite };
}
