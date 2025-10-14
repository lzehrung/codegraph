import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createTestIndex, testFindReferences } from './test-utils.js';

describe('Find References', () => {
  describe('TypeScript', () => {
    it('should find all references to exported function', async () => {
      const index = await createTestIndex('typescript');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'typescript');
      const utilsFile = path.join(samplePath, 'utils.ts').replace(/\\/g, '/');
      
      // Test find-references on helperFunction definition on line 1
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);
      
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.references.length).toBeGreaterThanOrEqual(1);
        
        // Should include the definition itself
        const definitionRef = result.references.find(ref => 
          ref.file === utilsFile && ref.range.start.line === 1
        );
        expect(definitionRef).toBeDefined();
      }
    });

    it('should find all references to exported class', async () => {
      const index = await createTestIndex('typescript');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'typescript');
      const utilsFile = path.join(samplePath, 'utils.ts').replace(/\\/g, '/');
      
      // Test find-references on UtilityClass definition on line 5
      const result = await testFindReferences(index, utilsFile, 5, 14, 2);
      
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.references.length).toBeGreaterThanOrEqual(1);
        
        // Should include the definition itself
        const definitionRef = result.references.find(ref => 
          ref.file === utilsFile && ref.range.start.line === 5
        );
        expect(definitionRef).toBeDefined();
      }
    });

    it('should find references to namespace member', async () => {
      const index = await createTestIndex('typescript');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'typescript');
      const utilsFile = path.join(samplePath, 'utils.ts').replace(/\\/g, '/');
      
      // Test find-references on helperFunction definition
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);
      
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        // Should find both direct usage and namespace usage
        const namespaceUsage = result.references.find(ref => 
          ref.file.includes('main.ts') && ref.via?.namespaceMember
        );
        expect(namespaceUsage).toBeDefined();
      }
    });
  });

  describe('Python', () => {
    it('should find all references to exported function', async () => {
      const index = await createTestIndex('python');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'python');
      const utilsFile = path.join(samplePath, 'utils.py').replace(/\\/g, '/');
      
      // Test find-references on helper_function definition on line 1
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);
      
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.references.length).toBeGreaterThanOrEqual(1);
        
        // Should include the definition itself
        const definitionRef = result.references.find(ref => 
          ref.file === utilsFile && ref.range.start.line === 1
        );
        expect(definitionRef).toBeDefined();
      }
    });

    it('should find all references to exported class', async () => {
      const index = await createTestIndex('python');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'python');
      const utilsFile = path.join(samplePath, 'utils.py').replace(/\\/g, '/');
      
      // Test find-references on UtilityClass definition on line 4
      const result = await testFindReferences(index, utilsFile, 4, 14, 2);
      
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.references.length).toBeGreaterThanOrEqual(1);
        
        // Should include the definition itself
        const definitionRef = result.references.find(ref => 
          ref.file === utilsFile && ref.range.start.line === 4
        );
        expect(definitionRef).toBeDefined();
      }
    });

    it('should find references to namespace member', async () => {
      const index = await createTestIndex('python');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'python');
      const utilsFile = path.join(samplePath, 'utils.py').replace(/\\/g, '/');
      
      // Test find-references on helper_function definition
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);
      
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        // Should find both direct usage and namespace usage
        const namespaceUsage = result.references.find(ref => 
          ref.file.includes('main.py') && ref.via?.namespaceMember
        );
        expect(namespaceUsage).toBeDefined();
      }
    });
  });

  describe('JavaScript', () => {
    it('should find all references to exported function', async () => {
      const index = await createTestIndex('javascript');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
      const utilsFile = path.join(samplePath, 'utils.js').replace(/\\/g, '/');
      
      // Test find-references on helperFunction definition on line 1
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);
      
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.references.length).toBeGreaterThanOrEqual(1);
        
        // Should include the definition itself
        const definitionRef = result.references.find(ref => 
          ref.file === utilsFile && ref.range.start.line === 1
        );
        expect(definitionRef).toBeDefined();
      }
    });

    it('should find all references to exported class', async () => {
      const index = await createTestIndex('javascript');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
      const utilsFile = path.join(samplePath, 'utils.js').replace(/\\/g, '/');
      
      // Test find-references on UtilityClass definition on line 4
      const result = await testFindReferences(index, utilsFile, 4, 14, 2);
      
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.references.length).toBeGreaterThanOrEqual(1);
        
        // Should include the definition itself
        const definitionRef = result.references.find(ref => 
          ref.file === utilsFile && ref.range.start.line === 4
        );
        expect(definitionRef).toBeDefined();
      }
    });

    it('should find references to namespace member', async () => {
      const index = await createTestIndex('javascript');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
      const utilsFile = path.join(samplePath, 'utils.js').replace(/\\/g, '/');
      
      // Test find-references on helperFunction definition
      const result = await testFindReferences(index, utilsFile, 1, 16, 3);
      
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        // Should find both direct usage and namespace usage
        const namespaceUsage = result.references.find(ref => 
          ref.file.includes('main.js') && ref.via?.namespaceMember
        );
        expect(namespaceUsage).toBeDefined();
      }
    });

    it('should find references to CommonJS exports', async () => {
      const index = await createTestIndex('javascript');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
      const legacyFile = path.join(samplePath, 'legacy.js').replace(/\\/g, '/');
      
      // Test find-references on legacyFunction definition on line 2
      const result = await testFindReferences(index, legacyFile, 2, 16, 2);
      
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.references.length).toBeGreaterThanOrEqual(1);
        
        // Should include the definition itself
        const definitionRef = result.references.find(ref => 
          ref.file === legacyFile && ref.range.start.line === 2
        );
        expect(definitionRef).toBeDefined();
      }
    });

    it('should find references in mixed module systems', async () => {
      const index = await createTestIndex('javascript');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
      const mixedFile = path.join(samplePath, 'mixed.js').replace(/\\/g, '/');
      
      // Test find-references on mixedFunction definition on line 4
      const result = await testFindReferences(index, mixedFile, 4, 16, 1);
      
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.references.length).toBeGreaterThanOrEqual(1);
        
        // Should include the definition itself
        const definitionRef = result.references.find(ref => 
          ref.file === mixedFile && ref.range.start.line === 4
        );
        expect(definitionRef).toBeDefined();
      }
    });
  });
});
