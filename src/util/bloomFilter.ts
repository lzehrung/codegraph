/**
 * Simple bloom filter implementation for fast reference pre-filtering
 *
 * Used to quickly determine if a file MIGHT contain references to a symbol,
 * allowing us to skip files that definitely don't contain the symbol.
 */

import crypto from "node:crypto";

export class BloomFilter {
  private bits: Uint8Array;
  private size: number;
  private hashCount: number;

  /**
   * Create a bloom filter
   * @param size - Number of bits in the filter (default: 10000)
   * @param hashCount - Number of hash functions to use (default: 3)
   */
  constructor(size = 10000, hashCount = 3) {
    this.size = size;
    this.hashCount = hashCount;
    this.bits = new Uint8Array(Math.ceil(size / 8));
  }

  /**
   * Add an item to the bloom filter
   */
  add(item: string): void {
    for (const hash of this.getHashes(item)) {
      const byteIndex = Math.floor(hash / 8);
      const bitIndex = hash % 8;
      if (byteIndex < 0 || byteIndex >= this.bits.length) return;
      const currentByte = this.bits[byteIndex];
      if (currentByte !== undefined) {
        this.bits[byteIndex] = currentByte | (1 << bitIndex);
      }
    }
  }

  /**
   * Check if an item might be in the set
   * Returns false if definitely not present, true if might be present
   */
  mightContain(item: string): boolean {
    for (const hash of this.getHashes(item)) {
      const byteIndex = Math.floor(hash / 8);
      const bitIndex = hash % 8;
      if (byteIndex < 0 || byteIndex >= this.bits.length) return false;
      const currentByte = this.bits[byteIndex];
      if (currentByte === undefined || (currentByte & (1 << bitIndex)) === 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Generate multiple hash values for an item
   */
  private *getHashes(item: string): Generator<number> {
    // Use a single hash and derive multiple values from it
    const hash = crypto.createHash("sha256").update(item).digest();

    for (let i = 0; i < this.hashCount; i++) {
      // Take different 4-byte segments of the hash
      const offset = (i * 4) % (hash.length - 4);
      const value = hash.readUInt32LE(offset);
      yield value % this.size;
    }
  }

  /**
   * Get the approximate false positive rate
   */
  getFalsePositiveRate(itemCount: number): number {
    // Formula: (1 - e^(-k*n/m))^k
    // where k = hashCount, n = itemCount, m = size
    const exp = Math.exp((-this.hashCount * itemCount) / this.size);
    return Math.pow(1 - exp, this.hashCount);
  }

  /**
   * Serialize to buffer for caching
   */
  toBuffer(): Buffer {
    return Buffer.from(this.bits);
  }

  /**
   * Deserialize from buffer
   */
  static fromBuffer(
    buffer: Buffer,
    size: number,
    hashCount: number,
  ): BloomFilter {
    const filter = new BloomFilter(size, hashCount);
    filter.bits = new Uint8Array(buffer);
    return filter;
  }

  /**
   * Get metadata for serialization
   */
  getMetadata(): { size: number; hashCount: number } {
    return { size: this.size, hashCount: this.hashCount };
  }
}

/**
 * Build a bloom filter from source code
 * Extracts all identifiers and adds them to the filter
 */
export function buildBloomFilterFromSource(
  source: string,
  languageId: string,
): BloomFilter {
  const filter = new BloomFilter();

  // Extract all identifiers using a simple regex
  // This is a fast heuristic - doesn't need to be perfect
  const identifierPattern = /\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g;
  const matches = source.match(identifierPattern);

  if (matches) {
    // Use a Set to deduplicate before adding to filter
    const unique = new Set(matches);
    for (const identifier of unique) {
      filter.add(identifier);
    }
  }

  return filter;
}

/**
 * Cache of bloom filters per file
 */
export class BloomFilterCache {
  private filters = new Map<string, BloomFilter>();

  set(file: string, filter: BloomFilter): void {
    this.filters.set(file, filter);
  }

  get(file: string): BloomFilter | undefined {
    return this.filters.get(file);
  }

  has(file: string): boolean {
    return this.filters.has(file);
  }

  /**
   * Check if a symbol might be in any of the provided files
   * Returns only files that might contain the symbol
   */
  filterFiles(symbol: string, files: string[]): string[] {
    const candidates: string[] = [];

    for (const file of files) {
      const filter = this.filters.get(file);
      if (!filter) {
        // If no filter exists, assume it might contain the symbol
        candidates.push(file);
      } else if (filter.mightContain(symbol)) {
        candidates.push(file);
      }
      // If filter exists and definitely doesn't contain symbol, skip
    }

    return candidates;
  }

  clear(): void {
    this.filters.clear();
  }

  size(): number {
    return this.filters.size;
  }
}
