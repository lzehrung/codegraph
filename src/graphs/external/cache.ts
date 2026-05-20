export class BoundedCacheMap<K, V> extends Map<K, V> {
  constructor(private readonly maxEntries: number) {
    super();
  }

  override set(key: K, value: V): this {
    if (super.has(key)) {
      super.delete(key);
    }
    super.set(key, value);
    while (this.size > this.maxEntries) {
      const oldest = this.keys().next();
      if (oldest.done) break;
      super.delete(oldest.value);
    }
    return this;
  }
}
