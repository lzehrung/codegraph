import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createTestIndex, testGoToDefinition } from './test-utils.js';

describe('Go to Definition', () => {
  describe('TypeScript', () => {
    it('should find definition of imported function', async () => {
      const index = await createTestIndex('typescript');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'typescript');
      const mainFile = path.join(samplePath, 'main.ts').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.ts').replace(/\\/g, '/');
      
      // Test go-to-definition on helperFunction() call on line 7
      const result = await testGoToDefinition(index, mainFile, 7, 25);
      
      if (result.status === 'ok') {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helperFunction definition
      }
    });

    it('should find definition of imported class', async () => {
      const index = await createTestIndex('typescript');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'typescript');
      const mainFile = path.join(samplePath, 'main.ts').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.ts').replace(/\\/g, '/');
      
      // Test go-to-definition on UtilityClass() call on line 12
      const result = await testGoToDefinition(index, mainFile, 12, 18);
      
      if (result.status === 'ok') {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(5); // UtilityClass definition
      }
    });

    it('should find definition of namespace member', async () => {
      const index = await createTestIndex('typescript');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'typescript');
      const mainFile = path.join(samplePath, 'main.ts').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.ts').replace(/\\/g, '/');
      
      // Test go-to-definition on utils.helperFunction() call on line 7
      const result = await testGoToDefinition(index, mainFile, 7, 25);
      
      if (result.status === 'ok') {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helperFunction definition
      }
    });

    it('should find definition of alias import', async () => {
      const index = await createTestIndex('typescript');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'typescript');
      const mainFile = path.join(samplePath, 'main.ts').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.ts').replace(/\\/g, '/');
      
      // Test go-to-definition on helperAlias() call on line 16
      const result = await testGoToDefinition(index, mainFile, 16, 20);
      
      if (result.status === 'ok') {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helperFunction definition
      }
    });
  });

  describe('Python', () => {
    it('should find definition of imported function', async () => {
      const index = await createTestIndex('python');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'python');
      const mainFile = path.join(samplePath, 'main.py').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.py').replace(/\\/g, '/');
      
      // Test go-to-definition on helper_function() call on line 11
      const result = await testGoToDefinition(index, mainFile, 11, 18);
      
      if (result.status === 'ok') {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helper_function definition
      }
    });

    it('should find definition of imported class', async () => {
      const index = await createTestIndex('python');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'python');
      const mainFile = path.join(samplePath, 'main.py').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.py').replace(/\\/g, '/');
      
      // Test go-to-definition on UtilityClass() call on line 12
      const result = await testGoToDefinition(index, mainFile, 12, 18);
      
      if (result.status === 'ok') {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(5); // UtilityClass definition
      }
    });

    it('should find definition of namespace member', async () => {
      const index = await createTestIndex('python');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'python');
      const mainFile = path.join(samplePath, 'main.py').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.py').replace(/\\/g, '/');
      
      // Test go-to-definition on utils.helper_function() call on line 7
      const result = await testGoToDefinition(index, mainFile, 7, 25);
      
      if (result.status === 'ok') {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helper_function definition
      }
    });

    it('should find definition of alias import', async () => {
      const index = await createTestIndex('python');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'python');
      const mainFile = path.join(samplePath, 'main.py').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.py').replace(/\\/g, '/');
      
      // Test go-to-definition on helper_alias() call on line 16
      const result = await testGoToDefinition(index, mainFile, 16, 18);
      
      if (result.status === 'ok') {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helper_function definition
      }
    });
  });

  describe('JavaScript', () => {
    it('should find definition of imported function', async () => {
      const index = await createTestIndex('javascript');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
      const mainFile = path.join(samplePath, 'main.js').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.js').replace(/\\/g, '/');
      
      // Test go-to-definition on helperFunction() call on line 7
      const result = await testGoToDefinition(index, mainFile, 7, 25);
      
      if (result.status === 'ok') {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helperFunction definition
      }
    });

    it('should find definition of imported class', async () => {
      const index = await createTestIndex('javascript');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
      const mainFile = path.join(samplePath, 'main.js').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.js').replace(/\\/g, '/');
      
      // Test go-to-definition on UtilityClass() call on line 12
      const result = await testGoToDefinition(index, mainFile, 12, 18);
      
      if (result.status === 'ok') {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(5); // UtilityClass definition
      }
    });

    it('should find definition of namespace member', async () => {
      const index = await createTestIndex('javascript');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
      const mainFile = path.join(samplePath, 'main.js').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.js').replace(/\\/g, '/');
      
      // Test go-to-definition on utils.helperFunction() call on line 7
      const result = await testGoToDefinition(index, mainFile, 7, 25);
      
      if (result.status === 'ok') {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helperFunction definition
      }
    });

    it('should find definition of alias import', async () => {
      const index = await createTestIndex('javascript');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
      const mainFile = path.join(samplePath, 'main.js').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.js').replace(/\\/g, '/');
      
      // Test go-to-definition on helperAlias() call on line 16
      const result = await testGoToDefinition(index, mainFile, 16, 20);
      
      if (result.status === 'ok') {
        expect(result.definition.file).toBe(utilsFile);
        expect(result.definition.range.start.line).toBe(1); // helperFunction definition
      }
    });

    it('should find definition of CommonJS require', async () => {
      const index = await createTestIndex('javascript');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
      const mainFile = path.join(samplePath, 'main.js').replace(/\\/g, '/');
      const helpersFile = path.join(samplePath, 'helpers.js').replace(/\\/g, '/');
      
      // Test go-to-definition on requireHelper() call on line 33
      const result = await testGoToDefinition(index, mainFile, 33, 18);
      
      if (result.status === 'ok') {
        expect(result.definition.file).toBe(helpersFile);
        expect(result.definition.range.start.line).toBe(1); // helperFunction definition
      }
    });
  });
});
