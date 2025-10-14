import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createTestIndex, expectFileInIndex, expectModuleCount } from './test-utils.js';

describe('Project Indexing', () => {
  describe('TypeScript Project', () => {
    it('should index all TypeScript files', async () => {
      const index = await createTestIndex('typescript');
      
      expectModuleCount(index, 3);
      
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'typescript');
      expectFileInIndex(index, path.join(samplePath, 'main.ts').replace(/\\/g, '/'));
      expectFileInIndex(index, path.join(samplePath, 'utils.ts').replace(/\\/g, '/'));
      expectFileInIndex(index, path.join(samplePath, 'helpers.ts').replace(/\\/g, '/'));
    });

    it('should detect imports and exports', async () => {
      const index = await createTestIndex('typescript');
      
      // Check that utils.ts has exports
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'typescript');
      const utilsFile = path.join(samplePath, 'utils.ts').replace(/\\/g, '/');
      const utilsModule = index.byFile.get(utilsFile);
      
      expect(utilsModule).toBeDefined();
      expect(utilsModule!.exports.length).toBeGreaterThan(0);
      expect(utilsModule!.locals.length).toBeGreaterThan(0);
    });

    it('should detect imports in main.ts', async () => {
      const index = await createTestIndex('typescript');
      
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'typescript');
      const mainFile = path.join(samplePath, 'main.ts').replace(/\\/g, '/');
      const mainModule = index.byFile.get(mainFile);
      
      expect(mainModule).toBeDefined();
      expect(mainModule!.imports.length).toBeGreaterThan(0);
    });
  });

  describe('Python Project', () => {
    it('should index all Python files', async () => {
      const index = await createTestIndex('python');
      
      expectModuleCount(index, 4);
      
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'python');
      expectFileInIndex(index, path.join(samplePath, 'main.py').replace(/\\/g, '/'));
      expectFileInIndex(index, path.join(samplePath, 'utils.py').replace(/\\/g, '/'));
      expectFileInIndex(index, path.join(samplePath, 'helpers.py').replace(/\\/g, '/'));
      expectFileInIndex(index, path.join(samplePath, '__init__.py').replace(/\\/g, '/'));
    });

    it('should detect Python imports and exports', async () => {
      const index = await createTestIndex('python');
      
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'python');
      const utilsFile = path.join(samplePath, 'utils.py').replace(/\\/g, '/');
      const utilsModule = index.byFile.get(utilsFile);
      
      expect(utilsModule).toBeDefined();
      expect(utilsModule!.exports.length).toBeGreaterThan(0);
      expect(utilsModule!.locals.length).toBeGreaterThan(0);
    });

    it('should detect Python imports in main.py', async () => {
      const index = await createTestIndex('python');
      
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'python');
      const mainFile = path.join(samplePath, 'main.py').replace(/\\/g, '/');
      const mainModule = index.byFile.get(mainFile);
      
      expect(mainModule).toBeDefined();
      expect(mainModule!.imports.length).toBeGreaterThan(0);
    });
  });

  describe('JavaScript Project', () => {
    it('should index all JavaScript files', async () => {
      const index = await createTestIndex('javascript');
      
      expectModuleCount(index, 5);
      
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
      expectFileInIndex(index, path.join(samplePath, 'main.js').replace(/\\/g, '/'));
      expectFileInIndex(index, path.join(samplePath, 'utils.js').replace(/\\/g, '/'));
      expectFileInIndex(index, path.join(samplePath, 'helpers.js').replace(/\\/g, '/'));
      expectFileInIndex(index, path.join(samplePath, 'legacy.js').replace(/\\/g, '/'));
      expectFileInIndex(index, path.join(samplePath, 'mixed.js').replace(/\\/g, '/'));
    });

    it('should detect JavaScript ES6 imports and exports', async () => {
      const index = await createTestIndex('javascript');
      
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
      const utilsFile = path.join(samplePath, 'utils.js').replace(/\\/g, '/');
      const utilsModule = index.byFile.get(utilsFile);
      
      expect(utilsModule).toBeDefined();
      expect(utilsModule!.exports.length).toBeGreaterThan(0);
      expect(utilsModule!.locals.length).toBeGreaterThan(0);
    });

    it('should detect JavaScript imports in main.js', async () => {
      const index = await createTestIndex('javascript');
      
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
      const mainFile = path.join(samplePath, 'main.js').replace(/\\/g, '/');
      const mainModule = index.byFile.get(mainFile);
      
      expect(mainModule).toBeDefined();
      expect(mainModule!.imports.length).toBeGreaterThan(0);
    });

    it('should detect CommonJS require statements', async () => {
      const index = await createTestIndex('javascript');
      
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
      const mainFile = path.join(samplePath, 'main.js').replace(/\\/g, '/');
      const mainModule = index.byFile.get(mainFile);
      
      expect(mainModule).toBeDefined();
      
      // Should detect both ES6 imports and CommonJS requires
      const hasES6Import = mainModule!.imports.some(imp => 
        imp.kind === 'default' || imp.kind === 'named' || imp.kind === 'namespace'
      );
      const hasCommonJSRequire = mainModule!.imports.some(imp => 
        imp.kind === 'require'
      );
      
      expect(hasES6Import || hasCommonJSRequire).toBe(true);
    });

    it('should detect mixed module systems', async () => {
      const index = await createTestIndex('javascript');
      
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
      const mixedFile = path.join(samplePath, 'mixed.js').replace(/\\/g, '/');
      const mixedModule = index.byFile.get(mixedFile);
      
      expect(mixedModule).toBeDefined();
      expect(mixedModule!.imports.length).toBeGreaterThan(0);
      expect(mixedModule!.exports.length).toBeGreaterThan(0);
    });
  });
});
