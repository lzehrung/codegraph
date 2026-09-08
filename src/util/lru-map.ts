export function lruMapGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  if (!map.has(key)) {
    return undefined;
  }
  const value = map.get(key)!;
  map.delete(key);
  map.set(key, value);
  return value;
}

export function lruMapSet<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxEntries) {
    const oldest = map.keys().next();
    if (!oldest.done) {
      map.delete(oldest.value);
    }
  }
  map.set(key, value);
}
