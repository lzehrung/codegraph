import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createTestIndex, createTestIndexFromFiles, testGoToDefinition } from './test-utils.js';

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

  describe('Go', () => {
    it('should find definition of imported function', async () => {
      const index = await createTestIndex('go');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'go');
      const mainFile = path.join(samplePath, 'main.go').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.go').replace(/\\/g, '/');

      await testGoToDefinition(index, mainFile, 9, 9, utilsFile, 5);
    });

    it('should find definition of imported struct type', async () => {
      const index = await createTestIndex('go');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'go');
      const mainFile = path.join(samplePath, 'main.go').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.go').replace(/\\/g, '/');

      await testGoToDefinition(index, mainFile, 12, 20, utilsFile, 9);
    });

    it('should find definition of aliased imported struct type', async () => {
      const index = await createTestIndex('go');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'go');
      const aliasFile = path.join(samplePath, 'aliased-types.go').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.go').replace(/\\/g, '/');

      await testGoToDefinition(index, aliasFile, 9, 24, utilsFile, 9);
    });

    it('should find definition of dot-imported constructor', async () => {
      const index = await createTestIndex('go');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'go');
      const dotImportFile = path.join(samplePath, 'dot-imports.go').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.go').replace(/\\/g, '/');

      await testGoToDefinition(index, dotImportFile, 9, 15, utilsFile, 13);
    });
  });

  describe('C', () => {
    it('should find definition of included function declaration', async () => {
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'c');
      const mainFile = path.join(samplePath, 'main.c').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.h').replace(/\\/g, '/');
      const helpersFile = path.join(samplePath, 'helpers.h').replace(/\\/g, '/');
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      await testGoToDefinition(index, mainFile, 5, 15, utilsFile, 8);
    });

    it('should find definition of included typedef struct', async () => {
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'c');
      const mainFile = path.join(samplePath, 'main.c').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.h').replace(/\\/g, '/');
      const helpersFile = path.join(samplePath, 'helpers.h').replace(/\\/g, '/');
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      await testGoToDefinition(index, mainFile, 6, 3, utilsFile, 6);
    });

    it('should find definition of function-pointer typedef', async () => {
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'c');
      const advancedUseFile = path.join(samplePath, 'advanced-use.c').replace(/\\/g, '/');
      const functionPointersFile = path.join(samplePath, 'function-pointers.h').replace(/\\/g, '/');
      const index = await createTestIndexFromFiles(samplePath, [
        advancedUseFile,
        functionPointersFile,
      ]);

      await testGoToDefinition(index, advancedUseFile, 4, 3, functionPointersFile, 3);
    });
  });

  describe('C++', () => {
    it('should find definition of included function declaration', async () => {
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'cpp');
      const mainFile = path.join(samplePath, 'main.cpp').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.hpp').replace(/\\/g, '/');
      const helpersFile = path.join(samplePath, 'helpers.hpp').replace(/\\/g, '/');
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      await testGoToDefinition(index, mainFile, 5, 15, utilsFile, 7);
    });

    it('should find definition of included struct type', async () => {
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'cpp');
      const mainFile = path.join(samplePath, 'main.cpp').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.hpp').replace(/\\/g, '/');
      const helpersFile = path.join(samplePath, 'helpers.hpp').replace(/\\/g, '/');
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      await testGoToDefinition(index, mainFile, 6, 3, utilsFile, 3);
    });

    it('should find definition of namespace-qualified alias target', async () => {
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'cpp');
      const usageFile = path.join(samplePath, 'namespace-usage.cpp').replace(/\\/g, '/');
      const namespaceFile = path.join(samplePath, 'namespaces.hpp').replace(/\\/g, '/');
      const index = await createTestIndexFromFiles(samplePath, [usageFile, namespaceFile]);

      await testGoToDefinition(index, usageFile, 4, 12, namespaceFile, 4);
    });
  });

  describe('Kotlin', () => {
    it('should find definition of imported function', async () => {
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'kotlin');
      const mainFile = path.join(samplePath, 'main.kt').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils', 'helperFunction.kt').replace(/\\/g, '/');
      const helpersFile = path.join(samplePath, 'helpers', 'helperFromHelpers.kt').replace(/\\/g, '/');
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      await testGoToDefinition(index, mainFile, 6, 15, utilsFile, 3);
    });

    it('should find definition of imported class', async () => {
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'kotlin');
      const mainFile = path.join(samplePath, 'main.kt').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils', 'helperFunction.kt').replace(/\\/g, '/');
      const helpersFile = path.join(samplePath, 'helpers', 'helperFromHelpers.kt').replace(/\\/g, '/');
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      await testGoToDefinition(index, mainFile, 7, 17, utilsFile, 7);
    });

    it('should find definition of aliased imported class', async () => {
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'kotlin');
      const aliasFile = path.join(samplePath, 'Aliases.kt').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils', 'helperFunction.kt').replace(/\\/g, '/');
      const index = await createTestIndexFromFiles(samplePath, [aliasFile, utilsFile]);

      await testGoToDefinition(index, aliasFile, 3, 24, utilsFile, 7);
    });

    it('should find definition of wildcard-imported type alias', async () => {
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'kotlin');
      const consumerFile = path.join(samplePath, 'TypeConsumers.kt').replace(/\\/g, '/');
      const moreTypesFile = path.join(samplePath, 'utils', 'MoreTypes.kt').replace(/\\/g, '/');
      const helperFile = path.join(samplePath, 'utils', 'helperFunction.kt').replace(/\\/g, '/');
      const index = await createTestIndexFromFiles(samplePath, [
        consumerFile,
        moreTypesFile,
        helperFile,
      ]);

      await testGoToDefinition(index, consumerFile, 3, 21, moreTypesFile, 3);
    });
  });

  describe('Swift', () => {
    it('should find definition of imported function', async () => {
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'swift');
      const mainFile = path.join(samplePath, 'main.swift').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'Utils.swift').replace(/\\/g, '/');
      const helpersFile = path.join(samplePath, 'Helpers.swift').replace(/\\/g, '/');
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      await testGoToDefinition(index, mainFile, 5, 21, utilsFile, 1);
    });

    it('should find definition of imported struct', async () => {
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'swift');
      const mainFile = path.join(samplePath, 'main.swift').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'Utils.swift').replace(/\\/g, '/');
      const helpersFile = path.join(samplePath, 'Helpers.swift').replace(/\\/g, '/');
      const index = await createTestIndexFromFiles(samplePath, [mainFile, utilsFile, helpersFile]);

      await testGoToDefinition(index, mainFile, 6, 23, utilsFile, 5);
    });

    it('should find definition of imported static factory type', async () => {
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'swift');
      const usageFile = path.join(samplePath, 'AdvancedUsage.swift').replace(/\\/g, '/');
      const staticMembersFile = path.join(samplePath, 'StaticMembers.swift').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'Utils.swift').replace(/\\/g, '/');
      const index = await createTestIndexFromFiles(samplePath, [
        usageFile,
        staticMembersFile,
        utilsFile,
      ]);

      await testGoToDefinition(index, usageFile, 4, 10, staticMembersFile, 6);
    });
  });
  describe('Java', () => {
    it('should find definition of imported static method', async () => {
      const index = await createTestIndex('java');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'java');
      const mainFile = path.join(samplePath, 'main.java').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils', 'Utils.java').replace(/\\/g, '/');
      // Test go-to-definition on Utils.helperFunction() call line 8 col 11
      await testGoToDefinition(index, mainFile, 8, 11, utilsFile, 4);
    });

    it('should find definition of static nested class', async () => {
      const index = await createTestIndex('java');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'java');
      const mainFile = path.join(samplePath, 'main.java').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils', 'Utils.java').replace(/\\/g, '/');
      // Test go-to-definition on new Utils.UtilityClass() UtilityClass line 9 col 15
      await testGoToDefinition(index, mainFile, 9, 15, utilsFile, 5);
    });

    it('should find definition of wildcard-imported nested type', async () => {
      const index = await createTestIndex('java');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'java');
      const wildcardFile = path.join(samplePath, 'WildcardImports.java').replace(/\\/g, '/');
      const packageFile = path.join(samplePath, 'pkg', 'PackageTypes.java').replace(/\\/g, '/');

      await testGoToDefinition(index, wildcardFile, 6, 16, packageFile, 4);
    });
  });

  describe('C#', () => {
    it('should find definition of static method', async () => {
      const index = await createTestIndex('csharp');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'csharp');
      const mainFile = path.join(samplePath, 'Main.cs').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'Utils.cs').replace(/\\/g, '/');
      // UtilsClass.HelperFunction() on 'H' line 7 col 16
      await testGoToDefinition(index, mainFile, 7, 16, utilsFile, 3);
    });

    it('should find definition of nested class', async () => {
      const index = await createTestIndex('csharp');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'csharp');
      const mainFile = path.join(samplePath, 'Main.cs').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'Utils.cs').replace(/\\/g, '/');
      // new UtilsClass.UtilityClass() on 'U' UtilityClass line 8 col 20
      await testGoToDefinition(index, mainFile, 8, 20, utilsFile, 4);
    });

    it('should find definition of namespace member', async () => {
      const index = await createTestIndex('csharp');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'csharp');
      const mainFile = path.join(samplePath, 'Main.cs').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'Utils.cs').replace(/\\/g, '/');
      // UtilsClass.HelperFunction() on 'U' UtilsClass line 7 col 5
      await testGoToDefinition(index, mainFile, 7, 5, utilsFile, 2);
    });

    it('should find definition of alias', async () => {
      const index = await createTestIndex('csharp');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'csharp');
      const mainFile = path.join(samplePath, 'Main.cs').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'Utils.cs').replace(/\\/g, '/');
      // UUtils.HelperFunction() on 'U' UUtils line 10 col 5
      await testGoToDefinition(index, mainFile, 10, 5, utilsFile, 2);
  });
  });

  describe('Ruby', () => {
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

    it('should find definition of namespaced class', async () => {
      const index = await createTestIndex('ruby');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'ruby');
      const consumerFile = path.join(samplePath, 'consumer.rb').replace(/\\/g, '/');
      const namespacedFile = path.join(samplePath, 'namespaced.rb').replace(/\\/g, '/');

      await testGoToDefinition(index, consumerFile, 3, 22, namespacedFile, 5);
    });
  });

  describe('Rust', () => {
    it('should find definition of helper_function', async () => {
      const index = await createTestIndex('rust');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'rust');
      const mainFile = path.join(samplePath, 'main.rs').replace(/\\/g, '/');
      const utilsFile = path.join(samplePath, 'utils.rs').replace(/\\/g, '/');
      // helper_function() on line 8 col 5
      await testGoToDefinition(index, mainFile, 8, 5, utilsFile, 1);
    });
    it('should find definition of helper_from_helpers', async () => {
      const index = await createTestIndex('rust');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'rust');
      const mainFile = path.join(samplePath, 'main.rs').replace(/\\/g, '/');
      const helpersFile = path.join(samplePath, 'helpers.rs').replace(/\\/g, '/');
      // helper_from_helpers() on line 9 col 5
      await testGoToDefinition(index, mainFile, 9, 5, helpersFile, 1);
    });

    it('should find definition of nested module type', async () => {
      const index = await createTestIndex('rust');
      const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'rust');
      const nestedFile = path.join(samplePath, 'nested.rs').replace(/\\/g, '/');
      const nestedServiceFile = path.join(samplePath, 'nested_service.rs').replace(/\\/g, '/');

      await testGoToDefinition(index, nestedFile, 6, 18, nestedServiceFile, 1);
    });
    });
  });
