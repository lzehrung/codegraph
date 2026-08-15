import { describe, it, expect } from "vitest";
import { fileIdentityKey } from "../src/util/paths.js";
import { setParsedCacheEntry } from "../src/indexer/parsed-cache.js";
import type { ParsedFileContext } from "../src/indexer/parse-context.js";
import { TS_SUPPORT } from "../src/languages.js";

function fakeParsed(file: string): ParsedFileContext {
  return {
    source: `// ${file}\n`,
    tree: {
      rootNode: {
        type: "program",
        startIndex: 0,
        endIndex: 0,
        startPosition: { row: 0, column: 0 },
        endPosition: { row: 0, column: 0 },
        childCount: 0,
        namedChildCount: 0,
        children: [],
        namedChildren: [],
        parent: null,
        child: () => null,
        namedChild: () => null,
        childForFieldName: () => null,
        descendantsOfType: () => [],
        walk: () => ({
          currentNode: null,
          gotoFirstChild: () => false,
          gotoNextSibling: () => false,
          gotoParent: () => false,
        }),
        text: "",
        isNamed: true,
        id: 0,
      },
    },
    sup: TS_SUPPORT,
  };
}

describe("parsed AST cache eviction", () => {
  it("keeps exact LRU key identity after touch and reinsert", () => {
    const parsedMap = new Map<string, ParsedFileContext>();
    const files = ["a.ts", "b.ts", "c.ts", "d.ts"];
    for (const file of files) {
      setParsedCacheEntry(parsedMap, file, fakeParsed(file), 2);
    }

    expect([...parsedMap.keys()]).toEqual([fileIdentityKey("c.ts"), fileIdentityKey("d.ts")]);

    const cEntry = parsedMap.get(fileIdentityKey("c.ts"))!;
    setParsedCacheEntry(parsedMap, "c.ts", cEntry, 2);
    expect([...parsedMap.keys()]).toEqual([fileIdentityKey("d.ts"), fileIdentityKey("c.ts")]);

    setParsedCacheEntry(parsedMap, "a.ts", fakeParsed("a.ts"), 2);
    expect([...parsedMap.keys()]).toEqual([fileIdentityKey("c.ts"), fileIdentityKey("a.ts")]);
  });
});
