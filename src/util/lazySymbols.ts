/**
 * Lazy symbol loading for reduced memory usage
 *
 * Instead of loading all symbols upfront, this module provides on-demand
 * loading of symbol data. This can reduce memory usage by 50% for large
 * repositories where only a subset of symbols are actually accessed.
 */

import picomatch from "picomatch";
import { supportForFile } from "../languages.js";
import { type ImportBinding, type ModuleIndex, type SymbolDef } from "../indexer/types.js";
import type { FileId } from "../types.js";
import { collectLocalsAndExportsFromSource } from "../indexer/locals-and-exports.js";
import { parsePreparedFileContext } from "../indexer/parse-context.js";

/**
 * Lazy-loadable module index
 */
export type LazyModuleIndex = {
  file: FileId;
  /** True if symbols are loaded */
  loaded: boolean;
  /** Import bindings (always loaded - small) */
  imports: ModuleIndex["imports"];
  /** Export entries (always loaded - small) */
  exports: ModuleIndex["exports"];
  /** Lazy-loaded locals */
  locals: LazyArray<SymbolDef>;
};

/**
 * Lazy array that loads on first access
 */
export class LazyArray<T> implements Iterable<T> {
  private data: T[] | null = null;
  private loader: () => Promise<T[]>;
  private loadPromise: Promise<T[]> | null = null;

  constructor(loader: () => Promise<T[]>) {
    this.loader = loader;
  }

  /**
   * Check if data is loaded
   */
  get isLoaded(): boolean {
    return this.data !== null;
  }

  /**
   * Get the length (loads data if needed)
   */
  async length(): Promise<number> {
    await this.ensureLoaded();
    return this.data!.length;
  }

  /**
   * Get all items (loads data if needed)
   */
  async getAll(): Promise<T[]> {
    await this.ensureLoaded();
    return this.data!;
  }

  /**
   * Get item at index (loads data if needed)
   */
  async get(index: number): Promise<T | undefined> {
    await this.ensureLoaded();
    return this.data![index];
  }

  /**
   * Filter items (loads data if needed)
   */
  async filter(predicate: (item: T) => boolean): Promise<T[]> {
    await this.ensureLoaded();
    return this.data!.filter(predicate);
  }

  /**
   * Map items (loads data if needed)
   */
  async map<U>(mapper: (item: T) => U): Promise<U[]> {
    await this.ensureLoaded();
    return this.data!.map(mapper);
  }

  /**
   * Find item (loads data if needed)
   */
  async find(predicate: (item: T) => boolean): Promise<T | undefined> {
    await this.ensureLoaded();
    return this.data!.find(predicate);
  }

  /**
   * Check if any item matches (loads data if needed)
   */
  async some(predicate: (item: T) => boolean): Promise<boolean> {
    await this.ensureLoaded();
    return this.data!.some(predicate);
  }

  /**
   * Iterate over items (loads data if needed)
   */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    await this.ensureLoaded();
    for (const item of this.data!) {
      yield item;
    }
  }

  /**
   * Synchronous iterator (throws if not loaded)
   */
  *[Symbol.iterator](): Iterator<T> {
    if (!this.isLoaded) {
      throw new Error("LazyArray not loaded - use getAll() or async iteration");
    }
    for (const item of this.data!) {
      yield item;
    }
  }

  /**
   * Ensure data is loaded
   */
  private async ensureLoaded(): Promise<void> {
    if (this.data !== null) return;

    if (this.loadPromise === null) {
      this.loadPromise = this.loader();
    }

    this.data = await this.loadPromise;
    this.loadPromise = null;
  }

  /**
   * Preload data in background
   */
  preload(): void {
    if (this.data === null && this.loadPromise === null) {
      this.loadPromise = this.loader();
      this.loadPromise
        .then((data) => {
          this.data = data;
          this.loadPromise = null;
        })
        .catch(() => {
          this.loadPromise = null;
        });
    }
  }

  /**
   * Unload data to free memory
   */
  unload(): void {
    this.data = null;
    this.loadPromise = null;
  }

  /**
   * Create from already-loaded data
   */
  static fromLoaded<T>(data: T[]): LazyArray<T> {
    const lazy = new LazyArray<T>(() => Promise.resolve(data));
    lazy.data = data;
    return lazy;
  }
}

/**
 * Options for lazy loading
 */
export type LazyLoadOptions = {
  /** Preload files matching these patterns */
  preloadPatterns?: string[];

  /** Maximum number of files to keep in memory */
  maxCached?: number;

  /** Preload strategy: "none", "critical", or "all" */
  preloadStrategy?: "none" | "critical" | "all";
};

/**
 * Lazy project index
 */
export class LazyProjectIndex {
  private modules = new Map<FileId, LazyModuleIndex>();
  private maxCached: number;
  private preloadStrategy: LazyLoadOptions["preloadStrategy"];
  private preloadMatcher: ((file: string) => boolean) | null;
  private loadedOrder: FileId[] = [];
  private readonly maxModuleEntries: number;

  constructor(options?: LazyLoadOptions) {
    this.maxCached =
      typeof options?.maxCached === "number" && Number.isFinite(options.maxCached)
        ? Math.max(0, Math.floor(options.maxCached))
        : 100;
    this.preloadStrategy = options?.preloadStrategy ?? "none";
    this.preloadMatcher = options?.preloadPatterns?.length ? picomatch(options.preloadPatterns, { dot: true }) : null;
    this.maxModuleEntries = Math.max(this.maxCached * 4, 256);
  }

  clear(): void {
    this.modules.clear();
    this.loadedOrder = [];
  }

  /**
   * Add a module with lazy-loaded symbols
   */
  addModule(file: FileId, module: LazyModuleIndex): void {
    this.syncModuleLoadedFlag(module);
    this.modules.set(file, module);
    if (module.loaded) {
      this.markModuleLoaded(file);
      this.enforceMaxCached(file);
    }
    this.autoPreloadModule(file, module);
    this.trimUnloadedModules();
  }

  /**
   * Get a module (loads symbols on demand)
   */
  async getModule(file: FileId): Promise<ModuleIndex | undefined> {
    const lazy = this.modules.get(file);
    if (!lazy) return undefined;

    // Convert lazy module to regular module
    const locals = await lazy.locals.getAll();
    this.syncModuleLoadedFlag(lazy);
    this.markModuleLoaded(file);
    this.enforceMaxCached(file);

    return {
      file: lazy.file,
      exports: lazy.exports,
      imports: lazy.imports,
      locals,
    };
  }

  /**
   * Get a module without loading symbols
   */
  getModuleShallow(file: FileId): LazyModuleIndex | undefined {
    return this.modules.get(file);
  }

  /**
   * Check if a file exists in the index
   */
  has(file: FileId): boolean {
    return this.modules.has(file);
  }

  /**
   * Get all file paths
   */
  getFiles(): FileId[] {
    return Array.from(this.modules.keys());
  }

  /**
   * Get count of loaded modules
   */
  getLoadedCount(): number {
    let count = 0;
    for (const mod of this.modules.values()) {
      this.syncModuleLoadedFlag(mod);
      if (mod.loaded) count++;
    }
    this.loadedOrder = this.loadedOrder.filter((file) => this.modules.get(file)?.loaded);
    for (const [file, mod] of this.modules) {
      if (mod.loaded && !this.loadedOrder.includes(file)) {
        this.loadedOrder.push(file);
      }
    }
    return count;
  }

  /**
   * Preload specific files
   */
  preload(files: FileId[]): void {
    for (const file of files) {
      const mod = this.modules.get(file);
      if (mod && !this.isModuleLoaded(mod)) {
        this.preloadModule(file, mod);
      }
    }
  }

  /**
   * Unload symbols for files not in the keep set
   */
  evict(keepFiles: Set<FileId>): void {
    for (const [file, mod] of this.modules) {
      if (!keepFiles.has(file) && this.isModuleLoaded(mod)) {
        mod.locals.unload();
        this.syncModuleLoadedFlag(mod);
        this.removeLoadedFile(file);
      }
    }
  }

  /**
   * Get memory usage statistics
   */
  getStats(): {
    totalModules: number;
    loadedModules: number;
    memoryUsageMB: number;
  } {
    const loadedCount = this.getLoadedCount();

    // Rough estimate: ~1KB per symbol, average 20 symbols per file
    const estimatedMemoryMB = (loadedCount * 20 * 1024) / (1024 * 1024);

    return {
      totalModules: this.modules.size,
      loadedModules: loadedCount,
      memoryUsageMB: Math.round(estimatedMemoryMB * 100) / 100,
    };
  }

  private isModuleLoaded(module: LazyModuleIndex): boolean {
    return module.locals.isLoaded || module.loaded;
  }

  private syncModuleLoadedFlag(module: LazyModuleIndex): void {
    module.loaded = module.locals.isLoaded;
  }

  private autoPreloadModule(file: FileId, module: LazyModuleIndex): void {
    if (module.loaded) {
      return;
    }
    if (this.preloadStrategy === "all") {
      this.preloadModule(file, module);
      return;
    }
    if (this.preloadStrategy === "critical" && this.shouldPreloadFile(file)) {
      this.preloadModule(file, module);
    }
  }

  private preloadModule(file: FileId, module: LazyModuleIndex): void {
    module.locals.preload();
    void module.locals.getAll().then(() => {
      this.syncModuleLoadedFlag(module);
      this.markModuleLoaded(file);
      this.enforceMaxCached(file);
    });
  }

  private shouldPreloadFile(file: FileId): boolean {
    if (!this.preloadMatcher) {
      return false;
    }
    return this.preloadMatcher(file.replace(/\\/g, "/"));
  }

  private markModuleLoaded(file: FileId): void {
    this.removeLoadedFile(file);
    this.loadedOrder.push(file);
  }

  private removeLoadedFile(file: FileId): void {
    const index = this.loadedOrder.indexOf(file);
    if (index >= 0) {
      this.loadedOrder.splice(index, 1);
    }
  }

  private enforceMaxCached(pinnedFile?: FileId): void {
    while (this.loadedOrder.length > this.maxCached) {
      const evictionIndex = this.loadedOrder.findIndex((file) => file !== pinnedFile);
      const victimIndex = evictionIndex >= 0 ? evictionIndex : 0;
      const [victim] = this.loadedOrder.splice(victimIndex, 1);
      if (!victim) {
        break;
      }
      const module = this.modules.get(victim);
      if (!module) {
        continue;
      }
      module.locals.unload();
      this.syncModuleLoadedFlag(module);
    }
    this.trimUnloadedModules();
  }

  private trimUnloadedModules(): void {
    if (this.modules.size <= this.maxModuleEntries) {
      return;
    }
    for (const [file, module] of this.modules) {
      if (this.isModuleLoaded(module)) {
        continue;
      }
      this.modules.delete(file);
      this.removeLoadedFile(file);
      if (this.modules.size <= this.maxModuleEntries) {
        break;
      }
    }
  }
}

/**
 * Create a lazy loader for a file's symbols
 */
export function createSymbolLoader(file: FileId, source: string, imports: ImportBinding[]): () => Promise<SymbolDef[]> {
  return () => {
    const sup = supportForFile(file);
    if (!sup) {
      throw new Error(`Unsupported file extension: ${file}`);
    }
    const parsed = parsePreparedFileContext({
      file,
      source,
      sup,
      nativeQueries: null,
    });
    const module = collectLocalsAndExportsFromSource(file, source, parsed.sup, imports, {
      tree: parsed.tree,
    });
    return Promise.resolve(module.locals);
  };
}
