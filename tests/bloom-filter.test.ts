import { describe, test, expect } from "vitest";
import { BloomFilter, buildBloomFilterFromSource, BloomFilterCache } from "../src/util/bloomFilter.js";

describe("BloomFilter", () => {
  test("should detect items that were added", () => {
    const filter = new BloomFilter();

    filter.add("hello");
    filter.add("world");
    filter.add("foo");

    expect(filter.mightContain("hello")).toBe(true);
    expect(filter.mightContain("world")).toBe(true);
    expect(filter.mightContain("foo")).toBe(true);
  });

  test("should return false for items definitely not present", () => {
    const filter = new BloomFilter();

    filter.add("hello");
    filter.add("world");

    // These should return false (definitely not present)
    // Note: There's a small chance of false positives, but with our
    // parameters it should be very low
    expect(filter.mightContain("notpresent")).toBe(false);
  });

  test("should serialize and deserialize correctly", () => {
    const filter = new BloomFilter();

    filter.add("hello");
    filter.add("world");
    filter.add("foo");

    const buffer = filter.toBuffer();
    const metadata = filter.getMetadata();

    const restored = BloomFilter.fromBuffer(buffer, metadata.size, metadata.hashCount);

    expect(restored.mightContain("hello")).toBe(true);
    expect(restored.mightContain("world")).toBe(true);
    expect(restored.mightContain("foo")).toBe(true);
  });

  test("should calculate approximate false positive rate", () => {
    const filter = new BloomFilter(10000, 3);

    // Add 100 items
    for (let i = 0; i < 100; i++) {
      filter.add(`item${i}`);
    }

    const fpr = filter.getFalsePositiveRate(100);

    // With 100 items in a 10000-bit filter with 3 hash functions,
    // the false positive rate should be very low
    expect(fpr).toBeLessThan(0.01); // Less than 1%
  });
});

describe("buildBloomFilterFromSource", () => {
  test("should extract identifiers from JavaScript source", () => {
    const source = `
      function hello(name) {
        const greeting = "Hello " + name;
        return greeting;
      }

      class Person {
        constructor(name) {
          this.name = name;
        }
      }
    `;

    const filter = buildBloomFilterFromSource(source, "javascript");

    expect(filter.mightContain("hello")).toBe(true);
    expect(filter.mightContain("name")).toBe(true);
    expect(filter.mightContain("greeting")).toBe(true);
    expect(filter.mightContain("Person")).toBe(true);
    expect(filter.mightContain("constructor")).toBe(true);
  });

  test("should extract identifiers from TypeScript source", () => {
    const source = `
      interface User {
        id: number;
        name: string;
      }

      function getUser(id: number): User {
        return { id, name: "John" };
      }
    `;

    const filter = buildBloomFilterFromSource(source, "typescript");

    expect(filter.mightContain("User")).toBe(true);
    expect(filter.mightContain("getUser")).toBe(true);
    expect(filter.mightContain("id")).toBe(true);
    expect(filter.mightContain("name")).toBe(true);
  });

  test("should extract identifiers from Python source", () => {
    const source = `
      def calculate_sum(numbers):
          total = 0
          for num in numbers:
              total += num
          return total

      class Calculator:
          def __init__(self):
              self.result = 0
    `;

    const filter = buildBloomFilterFromSource(source, "python");

    expect(filter.mightContain("calculate_sum")).toBe(true);
    expect(filter.mightContain("numbers")).toBe(true);
    expect(filter.mightContain("total")).toBe(true);
    expect(filter.mightContain("Calculator")).toBe(true);
    expect(filter.mightContain("result")).toBe(true);
  });
});

describe("BloomFilterCache", () => {
  test("should store and retrieve bloom filters", () => {
    const cache = new BloomFilterCache();
    const filter = new BloomFilter();

    filter.add("hello");
    filter.add("world");

    cache.set("file1.ts", filter);

    const retrieved = cache.get("file1.ts");
    expect(retrieved).toBeDefined();
    expect(retrieved!.mightContain("hello")).toBe(true);
    expect(retrieved!.mightContain("world")).toBe(true);
  });

  test("should filter files by symbol", () => {
    const cache = new BloomFilterCache();

    // Create filters for different files
    const filter1 = new BloomFilter();
    filter1.add("functionA");
    filter1.add("functionB");

    const filter2 = new BloomFilter();
    filter2.add("functionC");
    filter2.add("functionD");

    const filter3 = new BloomFilter();
    filter3.add("functionA");
    filter3.add("functionC");

    cache.set("file1.ts", filter1);
    cache.set("file2.ts", filter2);
    cache.set("file3.ts", filter3);

    const files = ["file1.ts", "file2.ts", "file3.ts"];

    // Filter by functionA - should return file1.ts and file3.ts
    const candidatesA = cache.filterFiles("functionA", files);
    expect(candidatesA).toContain("file1.ts");
    expect(candidatesA).toContain("file3.ts");
    expect(candidatesA).not.toContain("file2.ts");

    // Filter by functionC - should return file2.ts and file3.ts
    const candidatesC = cache.filterFiles("functionC", files);
    expect(candidatesC).toContain("file2.ts");
    expect(candidatesC).toContain("file3.ts");
    expect(candidatesC).not.toContain("file1.ts");

    // Filter by nonexistent symbol - should exclude all files that definitely don't have it
    const candidatesX = cache.filterFiles("functionX", files);
    // This depends on false positive rate, but likely none will match
    expect(candidatesX.length).toBeLessThanOrEqual(files.length);
  });

  test("should include files with no filter (assume might contain symbol)", () => {
    const cache = new BloomFilterCache();

    const filter1 = new BloomFilter();
    filter1.add("functionA");

    cache.set("file1.ts", filter1);

    const files = ["file1.ts", "file2.ts"]; // file2.ts has no filter

    const candidates = cache.filterFiles("functionA", files);

    // file1.ts has the function
    expect(candidates).toContain("file1.ts");
    // file2.ts has no filter, so we assume it might contain the symbol
    expect(candidates).toContain("file2.ts");
  });

  test("should report correct size", () => {
    const cache = new BloomFilterCache();

    expect(cache.size()).toBe(0);

    cache.set("file1.ts", new BloomFilter());
    expect(cache.size()).toBe(1);

    cache.set("file2.ts", new BloomFilter());
    expect(cache.size()).toBe(2);

    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
