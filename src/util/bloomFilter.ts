/**
 * Simple bloom filter implementation for fast reference pre-filtering
 *
 * Used to quickly determine if a file MIGHT contain references to a symbol,
 * allowing us to skip files that definitely don't contain the symbol.
 */

import crypto from "node:crypto";

/**
 * Calculate optimal bloom filter parameters for a target false positive rate.
 * @param expectedItems - Expected number of items to be added
 * @param falsePositiveRate - Target false positive rate (default: 0.01 = 1%)
 * @returns Optimal size in bits and hash count
 */
export function calculateOptimalBloomParams(expectedItems: number, falsePositiveRate = 0.01): { size: number; hashCount: number } {
  // Ensure reasonable bounds
  const n = Math.max(1, expectedItems);
  const p = Math.max(0.0001, Math.min(0.5, falsePositiveRate));

  // Optimal size: m = -n * ln(p) / (ln(2)^2)
  const ln2 = Math.LN2;
  const ln2Squared = ln2 * ln2;
  const optimalSize = Math.ceil((-n * Math.log(p)) / ln2Squared);

  // Optimal hash count: k = (m/n) * ln(2)
  const optimalHashCount = Math.max(1, Math.round((optimalSize / n) * ln2));

  // Clamp to reasonable bounds
  const size = Math.max(1000, Math.min(1000000, optimalSize)); // 1KB to 125KB
  const hashCount = Math.max(1, Math.min(10, optimalHashCount));

  return { size, hashCount };
}

export class BloomFilter {
  private bits: Uint8Array;
  private size: number;
  private hashCount: number;
  private itemCount: number = 0;

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
   * Create an optimally-sized bloom filter for the expected number of items.
   * @param expectedItems - Expected number of items to be added
   * @param falsePositiveRate - Target false positive rate (default: 0.01 = 1%)
   */
  static createOptimal(expectedItems: number, falsePositiveRate = 0.01): BloomFilter {
    const { size, hashCount } = calculateOptimalBloomParams(expectedItems, falsePositiveRate);
    return new BloomFilter(size, hashCount);
  }

  /**
   * Add an item to the bloom filter
   */
  add(item: string): void {
    // Set all bits first, only increment count if all operations succeed
    for (const hash of this.getHashes(item)) {
      const byteIndex = Math.floor(hash / 8);
      const bitIndex = hash % 8;
      if (byteIndex < 0 || byteIndex >= this.bits.length) return;
      const currentByte = this.bits[byteIndex];
      if (currentByte !== undefined) {
        this.bits[byteIndex] = currentByte | (1 << bitIndex);
      }
    }
    // Only increment after successful addition
    this.itemCount++;
  }

  /**
   * Get the number of items added to the filter
   */
  getItemCount(): number {
    return this.itemCount;
  }

  /**
   * Get the current estimated false positive rate based on items added
   */
  getCurrentFalsePositiveRate(): number {
    return this.getFalsePositiveRate(this.itemCount);
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
  static fromBuffer(buffer: Buffer, size: number, hashCount: number): BloomFilter {
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
 * Build a bloom filter from source code with auto-sizing.
 * Extracts all identifiers and adds them to an optimally-sized filter.
 * @param source - The source code to analyze
 * @param languageId - The language identifier (unused, for future extension)
 * @param falsePositiveRate - Target false positive rate (default: 0.01 = 1%)
 */
export function buildBloomFilterFromSource(source: string, languageId: string, falsePositiveRate = 0.01): BloomFilter {
  // Extract all identifiers using a simple regex
  // This is a fast heuristic - doesn't need to be perfect
  const identifierPattern = /\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g;
  const matches = source.match(identifierPattern);

  // Use a Set to deduplicate before sizing and adding
  const unique = matches ? new Set(matches) : new Set<string>();

  // Create optimally-sized filter based on unique identifier count
  const filter = BloomFilter.createOptimal(unique.size || 100, falsePositiveRate);

  for (const identifier of unique) {
    filter.add(identifier);
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
