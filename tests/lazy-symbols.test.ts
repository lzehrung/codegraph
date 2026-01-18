import { describe, test, expect } from "vitest";
import { LazyArray, LazyProjectIndex } from "../src/util/lazySymbols.js";

describe("LazyArray", () => {
  test("should not load data immediately", () => {
    let loaded = false;
    const lazy = new LazyArray(async () => {
      loaded = true;
      return [1, 2, 3];
    });

    expect(lazy.isLoaded).toBe(false);
    expect(loaded).toBe(false);
  });

  test("should load data on first access", async () => {
    const lazy = new LazyArray(async () => [1, 2, 3]);

    const data = await lazy.getAll();

    expect(lazy.isLoaded).toBe(true);
    expect(data).toEqual([1, 2, 3]);
  });

  test("should only load once", async () => {
    let loadCount = 0;
    const lazy = new LazyArray(async () => {
      loadCount++;
      return [1, 2, 3];
    });

    await lazy.getAll();
    await lazy.getAll();
    await lazy.getAll();

    expect(loadCount).toBe(1);
  });

  test("should get length", async () => {
    const lazy = new LazyArray(async () => [1, 2, 3, 4, 5]);

    const len = await lazy.length();

    expect(len).toBe(5);
    expect(lazy.isLoaded).toBe(true);
  });

  test("should get item by index", async () => {
    const lazy = new LazyArray(async () => ["a", "b", "c"]);

    const item = await lazy.get(1);

    expect(item).toBe("b");
  });

  test("should filter items", async () => {
    const lazy = new LazyArray(async () => [1, 2, 3, 4, 5]);

    const evens = await lazy.filter((n) => n % 2 === 0);

    expect(evens).toEqual([2, 4]);
  });

  test("should map items", async () => {
    const lazy = new LazyArray(async () => [1, 2, 3]);

    const doubled = await lazy.map((n) => n * 2);

    expect(doubled).toEqual([2, 4, 6]);
  });

  test("should find item", async () => {
    const lazy = new LazyArray(async () => [1, 2, 3, 4, 5]);

    const found = await lazy.find((n) => n > 3);

    expect(found).toBe(4);
  });

  test("should check if any matches", async () => {
    const lazy = new LazyArray(async () => [1, 2, 3]);

    const hasEven = await lazy.some((n) => n % 2 === 0);
    const hasLarge = await lazy.some((n) => n > 10);

    expect(hasEven).toBe(true);
    expect(hasLarge).toBe(false);
  });

  test("should support async iteration", async () => {
    const lazy = new LazyArray(async () => [1, 2, 3]);

    const items: number[] = [];
    for await (const item of lazy) {
      items.push(item);
    }

    expect(items).toEqual([1, 2, 3]);
  });

  test("should throw on sync iteration if not loaded", () => {
    const lazy = new LazyArray(async () => [1, 2, 3]);

    expect(() => {
      for (const _item of lazy) {
        // Should throw
      }
    }).toThrow();
  });

  test("should support sync iteration after loading", async () => {
    const lazy = new LazyArray(async () => [1, 2, 3]);

    await lazy.getAll();

    const items: number[] = [];
    for (const item of lazy) {
      items.push(item);
    }

    expect(items).toEqual([1, 2, 3]);
  });

  test("should preload in background", async () => {
    let loadStarted = false;
    const lazy = new LazyArray(async () => {
      loadStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [1, 2, 3];
    });

    lazy.preload();

    // Load should have started but not completed
    expect(loadStarted).toBe(true);
    expect(lazy.isLoaded).toBe(false);

    // Wait for load to complete
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(lazy.isLoaded).toBe(true);
  });

  test("should unload data", async () => {
    const lazy = new LazyArray(async () => [1, 2, 3]);

    await lazy.getAll();
    expect(lazy.isLoaded).toBe(true);

    lazy.unload();
    expect(lazy.isLoaded).toBe(false);

    // Should reload on next access
    const data = await lazy.getAll();
    expect(data).toEqual([1, 2, 3]);
  });

  test("should create from loaded data", async () => {
    const lazy = LazyArray.fromLoaded([1, 2, 3]);

    expect(lazy.isLoaded).toBe(true);

    const data = await lazy.getAll();
    expect(data).toEqual([1, 2, 3]);
  });
});

describe("LazyProjectIndex", () => {
  test("should create empty index", () => {
    const index = new LazyProjectIndex();

    expect(index.getFiles()).toEqual([]);
    expect(index.getLoadedCount()).toBe(0);
  });

  test("should add modules", () => {
    const index = new LazyProjectIndex();

    index.addModule("file1.ts", {
      file: "file1.ts",
      loaded: false,
      imports: [],
      exports: [],
      locals: new LazyArray(async () => []),
    });

    index.addModule("file2.ts", {
      file: "file2.ts",
      loaded: false,
      imports: [],
      exports: [],
      locals: new LazyArray(async () => []),
    });

    expect(index.getFiles()).toEqual(["file1.ts", "file2.ts"]);
    expect(index.has("file1.ts")).toBe(true);
    expect(index.has("file3.ts")).toBe(false);
  });

  test("should get module with lazy loading", async () => {
    const index = new LazyProjectIndex();

    index.addModule("file1.ts", {
      file: "file1.ts",
      loaded: false,
      imports: [],
      exports: [],
      locals: new LazyArray(async () => [
        {
          file: "file1.ts",
          localName: "foo",
          kind: 1,
          range: {
            start: { line: 1, column: 0, index: 0 },
            end: { line: 1, column: 3, index: 3 },
          },
        } as any,
      ]),
    });

    const module = await index.getModule("file1.ts");

    expect(module).toBeDefined();
    expect(module?.locals).toHaveLength(1);
    expect(module?.locals[0].localName).toBe("foo");
  });

  test("should get module without loading", () => {
    const index = new LazyProjectIndex();

    const lazy = new LazyArray(async () => []);
    index.addModule("file1.ts", {
      file: "file1.ts",
      loaded: false,
      imports: [],
      exports: [],
      locals: lazy,
    });

    const module = index.getModuleShallow("file1.ts");

    expect(module).toBeDefined();
    expect(module?.locals).toBe(lazy);
    expect(lazy.isLoaded).toBe(false);
  });

  test("should track loaded count", async () => {
    const index = new LazyProjectIndex();

    const module1 = {
      file: "file1.ts",
      loaded: false,
      imports: [],
      exports: [],
      locals: new LazyArray(async () => []),
    };

    const module2 = {
      file: "file2.ts",
      loaded: false,
      imports: [],
      exports: [],
      locals: new LazyArray(async () => []),
    };

    index.addModule("file1.ts", module1);
    index.addModule("file2.ts", module2);

    expect(index.getLoadedCount()).toBe(0);

    await module1.locals.getAll();
    module1.loaded = true;

    expect(index.getLoadedCount()).toBe(1);

    await module2.locals.getAll();
    module2.loaded = true;

    expect(index.getLoadedCount()).toBe(2);
  });

  test("should preload specific files", () => {
    const index = new LazyProjectIndex();

    let load1Started = false;
    let load2Started = false;

    index.addModule("file1.ts", {
      file: "file1.ts",
      loaded: false,
      imports: [],
      exports: [],
      locals: new LazyArray(async () => {
        load1Started = true;
        return [];
      }),
    });

    index.addModule("file2.ts", {
      file: "file2.ts",
      loaded: false,
      imports: [],
      exports: [],
      locals: new LazyArray(async () => {
        load2Started = true;
        return [];
      }),
    });

    index.preload(["file1.ts"]);

    expect(load1Started).toBe(true);
    expect(load2Started).toBe(false);
  });

  test("should get statistics", () => {
    const index = new LazyProjectIndex();

    index.addModule("file1.ts", {
      file: "file1.ts",
      loaded: true,
      imports: [],
      exports: [],
      locals: LazyArray.fromLoaded([]),
    });

    index.addModule("file2.ts", {
      file: "file2.ts",
      loaded: false,
      imports: [],
      exports: [],
      locals: new LazyArray(async () => []),
    });

    const stats = index.getStats();

    expect(stats.totalModules).toBe(2);
    expect(stats.loadedModules).toBe(1);
    expect(stats.memoryUsageMB).toBeGreaterThanOrEqual(0);
  });
});
