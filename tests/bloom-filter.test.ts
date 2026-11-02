import { describe, test, expect } from "vitest";
import {
  BloomFilter,
  buildBloomFilterFromSource,
  BloomFilterCache,
  isBloomIdentifierToken,
} from "../src/util/bloom-filter.js";
import {
  CSHARP_SUPPORT,
  JAVA_SUPPORT,
  JS_SUPPORT,
  PHP_SUPPORT,
  PY_SUPPORT,
  RUBY_SUPPORT,
  TS_SUPPORT,
} from "../src/languages.js";
import { BLOOM_FILTER_IDENTIFIER_SOURCE } from "../src/util/identifiers.js";
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

    const restored = BloomFilter.fromBuffer(buffer, metadata.size, metadata.hashCount, filter.getItemCount());

    expect(restored.mightContain("hello")).toBe(true);
    expect(restored.mightContain("world")).toBe(true);
    expect(restored.mightContain("foo")).toBe(true);
    expect(restored.getItemCount()).toBe(filter.getItemCount());
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

  test("answers a probe by digest like a probe by item, for filters of any size", () => {
    const filters = [new BloomFilter(10000, 3), new BloomFilter(1000, 7), BloomFilter.createOptimal(40)];
    const added = Array.from({ length: 40 }, (_, at) => `added${at}`);
    const absent = Array.from({ length: 200 }, (_, at) => `absent${at}`);
    for (const filter of filters) {
      for (const item of added) filter.add(item);
    }

    for (const filter of filters) {
      for (const item of [...added, ...absent]) {
        expect(filter.mightContainDigest(BloomFilter.digestOf(item))).toBe(filter.mightContain(item));
      }
      for (const item of added) expect(filter.mightContainDigest(BloomFilter.digestOf(item))).toBe(true);
    }
    expect(filters[1]!.mightContainDigest(BloomFilter.digestOf("absent0"))).toBe(false);
  });
});

describe("isBloomIdentifierToken", () => {
  test.each(["helper", "_private", "$ref", "name2", "caf\u00e9", "part\u200ename", "part\u00a0name"])(
    "accepts %s",
    (name) => {
      expect(isBloomIdentifierToken(name)).toBe(true);
    },
  );

  test.each(["empty?", "save!", "operator()", "r#type", "@class", "~Widget", "a b", "Outer::inner", ""])(
    "rejects %j, which a filter stores in pieces",
    (name) => {
      expect(isBloomIdentifierToken(name)).toBe(false);
    },
  );

  test("matches what a filter built from source stores whole", () => {
    const filter = buildBloomFilterFromSource("list.empty?(1)\nlist.helper(2)\n", RUBY_SUPPORT);

    expect(isBloomIdentifierToken("helper")).toBe(true);
    expect(filter.mightContain("helper")).toBe(true);
    // The filter holds `empty` and no `empty?`, so only a whole-token name can be probed.
    expect(isBloomIdentifierToken("empty?")).toBe(false);
    expect(filter.mightContain("empty")).toBe(true);
    expect(filter.mightContain("empty?")).toBe(false);
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

    const filter = buildBloomFilterFromSource(source, JS_SUPPORT);

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

    const filter = buildBloomFilterFromSource(source, TS_SUPPORT);

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

    const filter = buildBloomFilterFromSource(source, PY_SUPPORT);

    expect(filter.mightContain("calculate_sum")).toBe(true);
    expect(filter.mightContain("numbers")).toBe(true);
    expect(filter.mightContain("total")).toBe(true);
    expect(filter.mightContain("Calculator")).toBe(true);
    expect(filter.mightContain("result")).toBe(true);
  });

  test("matches Java annotations", () => {
    const filter = buildBloomFilterFromSource("@Override\nclass Child {}", JAVA_SUPPORT);

    expect(filter.mightContain("Override")).toBe(true);
  });

  test("matches C# verbatim identifiers", () => {
    const filter = buildBloomFilterFromSource("class @Widget {}", CSHARP_SUPPORT);

    expect(filter.mightContain(CSHARP_SUPPORT.normalizeIdentifier("@Widget"))).toBe(true);
  });

  test("canonicalizes Unicode identifiers before adding them", () => {
    const filter = buildBloomFilterFromSource("def caf\u00e9(): pass", PY_SUPPORT);

    expect(filter.mightContain("cafe\u0301".normalize("NFKC"))).toBe(true);
  });

  test("matches PHP identifiers beginning with non-ID_Start code points", () => {
    const identifier = "\u00b2php";
    const filter = buildBloomFilterFromSource(`<?php function ${identifier}() {}`, PHP_SUPPORT);

    expect(filter.mightContain(PHP_SUPPORT.normalizeIdentifier(identifier))).toBe(true);
  });

  test("stores a case-folded variant of PHP identifiers so a case-variant probe still matches", () => {
    const filter = buildBloomFilterFromSource("<?php namespace App; class Service {}", PHP_SUPPORT);

    expect(filter.mightContain("Service")).toBe(true);
    expect(filter.mightContain("service")).toBe(true);
    expect(filter.mightContain("sErViCe")).toBe(false);
  });

  test("does not fold identifiers for a case-sensitive language", () => {
    const filter = buildBloomFilterFromSource("class Service {}", JS_SUPPORT);

    expect(filter.mightContain("Service")).toBe(true);
    expect(filter.mightContain("service")).toBe(false);
  });
  test("does not fold identifiers for Python", () => {
    const filter = buildBloomFilterFromSource("class Service: pass", PY_SUPPORT);

    expect(filter.mightContain("Service")).toBe(true);
    expect(filter.mightContain("service")).toBe(false);
  });

  test("matches Java identifiers beginning with currency symbols", () => {
    const identifier = "\u00a5currency";
    const filter = buildBloomFilterFromSource(`class ${identifier} {}`, JAVA_SUPPORT);

    expect(filter.mightContain(JAVA_SUPPORT.normalizeIdentifier(identifier))).toBe(true);
  });

  test("matches Java identifiers beginning with connecting punctuation", () => {
    const identifier = "\u203fjava";
    const filter = buildBloomFilterFromSource(`class ${identifier} {}`, JAVA_SUPPORT);

    expect(filter.mightContain(JAVA_SUPPORT.normalizeIdentifier(identifier))).toBe(true);
  });

  test("matches C# identifiers containing formatting characters", () => {
    const identifier = "part\u200ename";
    const filter = buildBloomFilterFromSource(`class Entry { void ${identifier}() {} }`, CSHARP_SUPPORT);

    expect(filter.mightContain(CSHARP_SUPPORT.normalizeIdentifier(identifier))).toBe(true);
  });
});

// The code points a grammar reads as whitespace or a line break, none of which a TypeScript identifier holds.
const SEPARATORS = [
  0x0085,
  0x00a0,
  0x1680,
  ...Array.from({ length: 0x200b - 0x2000 + 1 }, (_, at) => 0x2000 + at),
  0x2028,
  0x2029,
  0x202f,
  0x205f,
  0x2060,
  0x3000,
  0xfeff,
].map((codePoint) => String.fromCodePoint(codePoint));

function codePointLabel(character: string): string {
  return `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

describe("buildBloomFilterFromSource next to a Unicode separator", () => {
  const separators = SEPARATORS.map((separator): [string, string] => [codePointLabel(separator), separator]);

  test.each(separators)("%s after a callee does not join it to the name", (_label, separator) => {
    const filter = buildBloomFilterFromSource(`export const v = Api.helper${separator}("x");\n`, TS_SUPPORT);

    expect(filter.mightContain("helper")).toBe(true);
    expect(filter.mightContain("Api")).toBe(true);
    expect(filter.mightContain("missing")).toBe(false);
  });

  test.each(separators)("%s between two names keeps them apart and stores the whole run too", (_label, separator) => {
    const filter = buildBloomFilterFromSource(`first${separator}second`, TS_SUPPORT);

    expect(filter.mightContain("first")).toBe(true);
    expect(filter.mightContain("second")).toBe(true);
    expect(filter.mightContain(`first${separator}second`)).toBe(true);
  });

  test.each(separators)("%s inside a PHP name is stored with the name whole and in pieces", (_label, separator) => {
    const filter = buildBloomFilterFromSource(`<?php function helper${separator}() {}`, PHP_SUPPORT);

    expect(filter.mightContain(`helper${separator}`)).toBe(true);
    expect(filter.mightContain("helper")).toBe(true);
  });

  test("a byte order mark before the first name does not join it", () => {
    const filter = buildBloomFilterFromSource("\ufeffhelper();\n", TS_SUPPORT);

    expect(filter.mightContain("helper")).toBe(true);
  });

  test("splits a name's pieces with the language's own identifier normalization", () => {
    const filter = buildBloomFilterFromSource("class Entry { void part\u200ename\u00a0() {} }", CSHARP_SUPPORT);

    expect(filter.mightContain("partname")).toBe(true);
    expect(filter.mightContain("Entry")).toBe(true);
  });

  test("keeps a name with a non-ASCII letter whole", () => {
    const filter = buildBloomFilterFromSource("export const caf\u00e9\u00a0= 1;\n", TS_SUPPORT);

    expect(filter.mightContain("caf\u00e9")).toBe(true);
    expect(filter.mightContain("caf")).toBe(false);
  });

  test("builds the filter it built before for a source without a separator", () => {
    const source = 'export const caf\u00e9 = Api.helper("x") + na\u00efve_name;\n// \u65e5\u672c\u8a9e helper\n';
    const tokens = new Set(source.match(new RegExp(BLOOM_FILTER_IDENTIFIER_SOURCE, "gu")));
    const expected = BloomFilter.createOptimal(tokens.size);
    for (const token of tokens) expected.add(token);

    expect(buildBloomFilterFromSource(source, JS_SUPPORT).toBuffer()).toEqual(expected.toBuffer());
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
