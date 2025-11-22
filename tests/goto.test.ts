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
  describe.skip('Java', () => {
    it('should find definition of imported static method', async () => {
      const index = await createTestIndex('java');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'java');
      const mainFile = path.join(samplePath, 'main.java').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.java').replace(/\\/g, '/');
      // Test go-to-definition on Utils.helperFunction() call line 8 col 11
      await testGoToDefinition(index, mainFile, 8, 11, utilsFile, 4);
    });

    it('should find definition of static nested class', async () => {
      const index = await createTestIndex('java');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'java');
      const mainFile = path.join(samplePath, 'main.java').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.java').replace(/\\/g, '/');
      // Test go-to-definition on new Utils.UtilityClass() UtilityClass line 9 col 15
      await testGoToDefinition(index, mainFile, 9, 15, utilsFile, 5);
    });
  });

  describe.skip('C#', () => {
    it('should find definition of static method', async () => {
      const index = await createTestIndex('csharp');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'csharp');
      const mainFile = path.join(samplePath, 'main.cs').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.cs').replace(/\\/g, '/');
      // UtilsClass.HelperFunction() on 'H' line 6 col 16
      await testGoToDefinition(index, mainFile, 6, 16, utilsFile, 3);
    });

    it('should find definition of nested class', async () => {
      const index = await createTestIndex('csharp');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'csharp');
      const mainFile = path.join(samplePath, 'main.cs').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.cs').replace(/\\/g, '/');
      // new UtilsClass.UtilityClass() on 'U' UtilityClass line 7 col 20
      await testGoToDefinition(index, mainFile, 7, 20, utilsFile, 4);
    });

    it('should find definition of namespace member', async () => {
      const index = await createTestIndex('csharp');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'csharp');
      const mainFile = path.join(samplePath, 'main.cs').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.cs').replace(/\\/g, '/');
      // UtilsClass.HelperFunction() on 'U' UtilsClass line 6 col 5
      await testGoToDefinition(index, mainFile, 6, 5, utilsFile, 2);
    });

    it('should find definition of alias', async () => {
      const index = await createTestIndex('csharp');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'csharp');
      const mainFile = path.join(samplePath, 'main.cs').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.cs').replace(/\\/g, '/');
      // UUtils.HelperFunction() on 'U' UUtils line 9 col 5
      await testGoToDefinition(index, mainFile, 9, 5, utilsFile, 2);
    });
  });
  });

  describe.skip('Ruby', () => {
    it('should find definition of module function', async () => {
      const index = await createTestIndex('ruby');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'ruby');
      const mainFile = path.join(samplePath, 'main.rb').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.rb').replace(/\\/g, '/');
      // Test go-to-definition on Utils.helper_function call line 4 col 7
      await testGoToDefinition(index, mainFile, 4, 7, utilsFile, 2);
    });
    it('should find definition of class', async () => {
      const index = await createTestIndex('ruby');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'ruby');
      const mainFile = path.join(samplePath, 'main.rb').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.rb').replace(/\\/g, '/');
      // Test go-to-definition on Utils::UtilityClass line 6 col 13
      await testGoToDefinition(index, mainFile, 6, 13, utilsFile, 4);
    });
  });
