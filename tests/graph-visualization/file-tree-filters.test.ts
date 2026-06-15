// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  kindAbbrev,
  matchesFilter,
  subtreeMatchesFilter,
  highlightMatch,
} from "../../docs/graph-visualization/file-tree-filters.js";

describe("kindAbbrev", () => {
  it("maps known kinds to abbreviations", () => {
    expect(kindAbbrev("function")).toBe("fn");
    expect(kindAbbrev("class")).toBe("cls");
    expect(kindAbbrev("type")).toBe("ty");
    expect(kindAbbrev("variable")).toBe("var");
    expect(kindAbbrev("import")).toBe("imp");
  });

  it("falls back to first 3 characters for unknown kinds", () => {
    expect(kindAbbrev("interface")).toBe("int");
    expect(kindAbbrev("enum")).toBe("enu");
  });

  it("returns ? for null/undefined/empty", () => {
    expect(Reflect.apply(kindAbbrev, undefined, [undefined])).toBe("?");
    expect(Reflect.apply(kindAbbrev, undefined, [null])).toBe("?");
    expect(kindAbbrev("")).toBe("?");
  });
});

describe("matchesFilter", () => {
  it("returns true when no filter", () => {
    expect(Reflect.apply(matchesFilter, undefined, ["anything", null])).toBe(true);
    expect(matchesFilter("anything", "")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(matchesFilter("FooBar", "foobar")).toBe(true);
    expect(matchesFilter("foobar", "FOOBAR")).toBe(true);
  });

  it("matches substring", () => {
    expect(matchesFilter("formatDate", "Date")).toBe(true);
    expect(matchesFilter("formatDate", "xyz")).toBe(false);
  });
});

describe("subtreeMatchesFilter", () => {
  it("returns true when no filter", () => {
    expect(Reflect.apply(subtreeMatchesFilter, undefined, [{ name: "x", type: "file" }, null])).toBe(true);
  });

  it("matches the node name itself", () => {
    expect(subtreeMatchesFilter({ name: "helper.ts", type: "file", symbols: [] }, "helper")).toBe(true);
  });

  it("matches a child in a directory", () => {
    const dir = {
      name: "utils",
      type: "directory",
      children: [{ name: "helper.ts", type: "file", symbols: [] }],
    };
    expect(subtreeMatchesFilter(dir, "helper")).toBe(true);
    expect(subtreeMatchesFilter(dir, "xyz")).toBe(false);
  });

  it("matches a symbol inside a file", () => {
    const file = {
      name: "index.ts",
      type: "file",
      symbols: [{ name: "formatDate" }],
    };
    expect(subtreeMatchesFilter(file, "format")).toBe(true);
    expect(subtreeMatchesFilter(file, "xyz")).toBe(false);
  });

  it("searches recursively through nested directories", () => {
    const tree = {
      name: "root",
      type: "directory",
      children: [
        {
          name: "a",
          type: "directory",
          children: [
            {
              name: "b.ts",
              type: "file",
              symbols: [{ name: "deepSymbol" }],
            },
          ],
        },
      ],
    };
    expect(subtreeMatchesFilter(tree, "deepSymbol")).toBe(true);
  });
});

describe("highlightMatch", () => {
  it("returns plain text node when no filter", () => {
    const result = Reflect.apply(highlightMatch, undefined, ["hello", null]);
    expect(result.nodeType).toBe(Node.TEXT_NODE);
    expect(result.textContent).toBe("hello");
  });

  it("returns plain text node when no match", () => {
    const result = highlightMatch("hello", "xyz");
    expect(result.nodeType).toBe(Node.TEXT_NODE);
    expect(result.textContent).toBe("hello");
  });

  it("wraps matching portion in <mark>", () => {
    const result = highlightMatch("formatDate", "Date");
    // result is a DocumentFragment
    expect(result.nodeType).toBe(Node.DOCUMENT_FRAGMENT_NODE);
    const children = Array.from(result.childNodes);
    expect(children.length).toBe(2); // "format" text + <mark>Date</mark>
    expect(children[0].textContent).toBe("format");
    expect(children[1].nodeName).toBe("MARK");
    expect(children[1].textContent).toBe("Date");
  });

  it("handles match at start of string", () => {
    const result = highlightMatch("hello world", "hello");
    const children = Array.from(result.childNodes);
    expect(children[0].nodeName).toBe("MARK");
    expect(children[0].textContent).toBe("hello");
    expect(children[1].textContent).toBe(" world");
  });

  it("handles match at end of string", () => {
    const result = highlightMatch("hello world", "world");
    const children = Array.from(result.childNodes);
    expect(children[0].textContent).toBe("hello ");
    expect(children[1].nodeName).toBe("MARK");
    expect(children[1].textContent).toBe("world");
  });

  it("handles full string match", () => {
    const result = highlightMatch("test", "test");
    const children = Array.from(result.childNodes);
    expect(children.length).toBe(1);
    expect(children[0].nodeName).toBe("MARK");
    expect(children[0].textContent).toBe("test");
  });

  it("matches case-insensitively but preserves original case", () => {
    const result = highlightMatch("FormatDate", "format");
    const children = Array.from(result.childNodes);
    expect(children[0].nodeName).toBe("MARK");
    expect(children[0].textContent).toBe("Format");
  });
});
