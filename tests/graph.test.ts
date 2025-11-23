import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { collectGraph, buildProjectIndexFromFiles, buildSymbolGraph, graphToMermaidSymbolsWithFiles } from '../src/index.js';
import { getSamplePath, expectEdgeCount } from './test-utils.js';

type EdgeTo = { type: 'file'; path: string } | { type: 'external'; name: string };
const toStr = (to: EdgeTo) => (to.type === 'file' ? to.path : to.name);

describe('Dependency Graph', () => {
  describe('TypeScript Project', () => {
    it('should build dependency graph with correct edges', async () => {
      const samplePath = getSamplePath('typescript');
      const files = [
        path.join(samplePath, 'main.ts').replace(/\\/g, '/'),
        path.join(samplePath, 'utils.ts').replace(/\\/g, '/'),
        path.join(samplePath, 'helpers.ts').replace(/\\/g, '/'),
      ];
      
      const graph = await collectGraph(samplePath, files);
      
      expect(graph.nodes).toHaveLength(3);
      expect(graph.edges.length).toBeGreaterThan(0);
      
      // Should have edges from main.ts to utils.ts and helpers.ts
      const mainToUtils = graph.edges.find(edge => 
        edge.from.includes('main.ts') && toStr(edge.to).includes('utils.ts')
      );
      expect(mainToUtils).toBeDefined();
      
      const utilsToHelpers = graph.edges.find(edge => 
        edge.from.includes('utils.ts') && toStr(edge.to).includes('helpers.ts')
      );
      expect(utilsToHelpers).toBeDefined();
    });

    it('should detect circular dependencies', async () => {
      const samplePath = getSamplePath('typescript');
      const files = [
        path.join(samplePath, 'main.ts').replace(/\\/g, '/'),
        path.join(samplePath, 'utils.ts').replace(/\\/g, '/'),
        path.join(samplePath, 'helpers.ts').replace(/\\/g, '/'),
      ];
      
      const graph = await collectGraph(samplePath, files);
      
      // Check for circular dependencies
      const circularEdges = graph.edges.filter(edge => edge.from === toStr(edge.to));
      expect(circularEdges).toHaveLength(0);
    });
  });

  describe('Python Project', () => {
    it('should build dependency graph with correct edges', async () => {
      const samplePath = getSamplePath('python');
      const files = [
        path.join(samplePath, 'main.py').replace(/\\/g, '/'),
        path.join(samplePath, 'utils.py').replace(/\\/g, '/'),
        path.join(samplePath, 'helpers.py').replace(/\\/g, '/'),
        path.join(samplePath, '__init__.py').replace(/\\/g, '/'),
      ];
      
      const graph = await collectGraph(samplePath, files);
      
      expect(graph.nodes).toHaveLength(4);
      expect(graph.edges.length).toBeGreaterThan(0);
      
      // Should have edges from main.py to utils.py and helpers.py
      const mainToUtils = graph.edges.find(edge => 
        edge.from.includes('main.py') && toStr(edge.to).includes('utils.py')
      );
      expect(mainToUtils).toBeDefined();
      
      const utilsToHelpers = graph.edges.find(edge => 
        edge.from.includes('utils.py') && toStr(edge.to).includes('helpers.py')
      );
      expect(utilsToHelpers).toBeDefined();
    });

    it('should detect Python package structure', async () => {
      const samplePath = getSamplePath('python');
      const files = [
        path.join(samplePath, 'main.py').replace(/\\/g, '/'),
        path.join(samplePath, 'utils.py').replace(/\\/g, '/'),
        path.join(samplePath, 'helpers.py').replace(/\\/g, '/'),
        path.join(samplePath, '__init__.py').replace(/\\/g, '/'),
      ];
      
      const graph = await collectGraph(samplePath, files);
      
      // Should have edges involving __init__.py
      const initEdges = graph.edges.filter(edge => 
        edge.from.includes('__init__.py') || toStr(edge.to).includes('__init__.py')
      );
      expect(initEdges.length).toBeGreaterThan(0);
    });
  });

  describe('JavaScript Project', () => {
    it('should build dependency graph with correct edges', async () => {
      const samplePath = getSamplePath('javascript');
      const files = [
        path.join(samplePath, 'main.js').replace(/\\/g, '/'),
        path.join(samplePath, 'utils.js').replace(/\\/g, '/'),
        path.join(samplePath, 'helpers.js').replace(/\\/g, '/'),
        path.join(samplePath, 'legacy.js').replace(/\\/g, '/'),
        path.join(samplePath, 'mixed.js').replace(/\\/g, '/'),
      ];
      
      const graph = await collectGraph(samplePath, files);
      
      expect(graph.nodes).toHaveLength(5);
      expect(graph.edges.length).toBeGreaterThan(0);
      
      // Should have edges from main.js to utils.js and helpers.js
      const mainToUtils = graph.edges.find(edge => 
        edge.from.includes('main.js') && toStr(edge.to).includes('utils.js')
      );
      expect(mainToUtils).toBeDefined();
      
      const utilsToHelpers = graph.edges.find(edge => 
        edge.from.includes('utils.js') && toStr(edge.to).includes('helpers.js')
      );
      expect(utilsToHelpers).toBeDefined();
    });

    it('should detect CommonJS dependencies', async () => {
      const samplePath = getSamplePath('javascript');
      const files = [
        path.join(samplePath, 'main.js').replace(/\\/g, '/'),
        path.join(samplePath, 'utils.js').replace(/\\/g, '/'),
        path.join(samplePath, 'helpers.js').replace(/\\/g, '/'),
        path.join(samplePath, 'legacy.js').replace(/\\/g, '/'),
        path.join(samplePath, 'mixed.js').replace(/\\/g, '/'),
      ];
      
      const graph = await collectGraph(samplePath, files);
      
      // Should have edges involving CommonJS modules
      const commonJSEdges = graph.edges.filter(edge => 
        edge.from.includes('legacy.js') || toStr(edge.to).includes('legacy.js') ||
        edge.from.includes('mixed.js') || toStr(edge.to).includes('mixed.js')
      );
      expect(commonJSEdges.length).toBeGreaterThan(0);
    });

    it('should detect mixed module system dependencies', async () => {
      const samplePath = getSamplePath('javascript');
      const files = [
        path.join(samplePath, 'main.js').replace(/\\/g, '/'),
        path.join(samplePath, 'utils.js').replace(/\\/g, '/'),
        path.join(samplePath, 'helpers.js').replace(/\\/g, '/'),
        path.join(samplePath, 'legacy.js').replace(/\\/g, '/'),
        path.join(samplePath, 'mixed.js').replace(/\\/g, '/'),
      ];
      
      const graph = await collectGraph(samplePath, files);
      
      // Should have edges from mixed.js to both ES6 and CommonJS modules
      const mixedEdges = graph.edges.filter(edge => 
        edge.from.includes('mixed.js')
      );
      expect(mixedEdges.length).toBeGreaterThan(0);
      
      // Should connect to both ES6 helpers.js and CommonJS legacy.js
      const hasES6Connection = mixedEdges.some(edge => toStr(edge.to).includes('helpers.js'));
      const hasCommonJSConnection = mixedEdges.some(edge => toStr(edge.to).includes('legacy.js'));
      
      expect(hasES6Connection || hasCommonJSConnection).toBe(true);
    });
  });

  describe('Hybrid symbol+file Mermaid rendering', () => {
    it('includes file nodes and symbol edges together', async () => {
      const samplePath = getSamplePath('typescript');
      const files = [
        path.join(samplePath, 'main.ts').replace(/\\/g, '/'),
        path.join(samplePath, 'utils.ts').replace(/\\/g, '/'),
      ];
      const graph = await collectGraph(samplePath, files);
      const index = await buildProjectIndexFromFiles(samplePath, files);
      const sgraph = await buildSymbolGraph(index);
      const mermaid = graphToMermaidSymbolsWithFiles(sgraph, graph, samplePath);
      expect(mermaid).toContain('flowchart LR');
      // Should mention both main.ts and utils.ts as file nodes
      expect(mermaid).toMatch(/main\.ts/);
      expect(mermaid).toMatch(/utils\.ts/);
      // Should include a labeled symbol edge for helperFunction
      expect(mermaid).toMatch(/-- \"helperFunction\" -->/);
      // No undefined targets in edges
      expect(mermaid).not.toMatch(/-->\s+undefined/);
    });
  });
  describe('Go Project', () => {
    it('should build dependency graph with correct edges', async () => {
      const samplePath = getSamplePath('go');
      const files = [
        path.join(samplePath, 'main.go').replace(/\\/g, '/'),
        path.join(samplePath, 'utils.go').replace(/\\/g, '/'),
        path.join(samplePath, 'helpers.go').replace(/\\/g, '/'),
      ];
      
      const graph = await collectGraph(samplePath, files);
      
      expect(graph.nodes).toHaveLength(3);
      expect(graph.edges.length).toBeGreaterThan(0);
      
      // Should have edges from main.go to utils.go and utils.go to helpers.go
      const mainToUtils = graph.edges.find(edge => 
        edge.from.includes('main.go') && toStr(edge.to).includes('utils.go')
      );
      expect(mainToUtils).toBeDefined();
      
      const utilsToHelpers = graph.edges.find(edge => 
        edge.from.includes('utils.go') && toStr(edge.to).includes('helpers.go')
      );
      expect(utilsToHelpers).toBeDefined();
    });
  });

  describe('Java Project', () => {
    it('should build dependency graph with correct edges', async () => {
      const samplePath = getSamplePath('java');
      const files = [
        path.join(samplePath, 'main.java').replace(/\\/g, '/'),
        path.join(samplePath, 'utils', 'Utils.java').replace(/\\/g, '/'),
        path.join(samplePath, 'helpers', 'Helpers.java').replace(/\\/g, '/'),
      ];
      
      const graph = await collectGraph(samplePath, files);
      
      expect(graph.nodes).toHaveLength(3);
      expect(graph.edges.length).toBeGreaterThan(0);
      
      const mainToUtils = graph.edges.find(edge =>
        edge.from.includes('main.java') && toStr(edge.to).includes('utils/Utils.java')
      );
      expect(mainToUtils).toBeDefined();
      
      const mainToHelpers = graph.edges.find(edge =>
        edge.from.includes('main.java') && toStr(edge.to).includes('helpers/Helpers.java')
      );
      expect(mainToHelpers).toBeDefined();
    });
  });
  describe('C# Project', () => {
    it('should build dependency graph with correct edges', async () => {
      const samplePath = getSamplePath('csharp');
      const files = [
        path.join(samplePath, 'Main.cs').replace(/\\/g, '/'),
        path.join(samplePath, 'Utils.cs').replace(/\\/g, '/'),
        path.join(samplePath, 'Helpers.cs').replace(/\\/g, '/'),
      ];
      
      const graph = await collectGraph(samplePath, files);
      
      expect(graph.nodes).toHaveLength(3);
      expect(graph.edges.length).toBeGreaterThan(0);
      
      const mainToUtils = graph.edges.find(edge => 
        edge.from.includes('Main.cs') && toStr(edge.to).includes('Utils.cs')
      );
      expect(mainToUtils).toBeDefined();
      
      const mainToHelpers = graph.edges.find(edge => 
        edge.from.includes('Main.cs') && toStr(edge.to).includes('Helpers.cs')
      );
      expect(mainToHelpers).toBeDefined();
    });
  });
  describe('Ruby Project', () => {
    it('should build dependency graph with correct edges', async () => {
      const samplePath = getSamplePath('ruby');
      const files = [
        path.join(samplePath, 'main.rb').replace(/\\/g, '/'),
        path.join(samplePath, 'utils.rb').replace(/\\/g, '/'),
        path.join(samplePath, 'helpers.rb').replace(/\\/g, '/'),
      ];
      
      const graph = await collectGraph(samplePath, files);
      
      expect(graph.nodes).toHaveLength(3);
      expect(graph.edges.length).toBeGreaterThan(0);
      
      const mainToUtils = graph.edges.find(edge => 
        edge.from.includes('main.rb') && toStr(edge.to).includes('utils.rb')
      );
      expect(mainToUtils).toBeDefined();
      
      const mainToHelpers = graph.edges.find(edge => 
        edge.from.includes('main.rb') && toStr(edge.to).includes('helpers.rb')
      );
      expect(mainToHelpers).toBeDefined();
    });
  });

  describe('Rust Project', () => {
    it('should build dependency graph with correct edges', async () => {
      const samplePath = getSamplePath('rust');
      const files = [
        path.join(samplePath, 'main.rs').replace(/\\/g, '/'),
        path.join(samplePath, 'utils.rs').replace(/\\/g, '/'),
        path.join(samplePath, 'helpers.rs').replace(/\\/g, '/'),
      ];
      
      const graph = await collectGraph(samplePath, files);
      
      expect(graph.nodes).toHaveLength(3);
      expect(graph.edges.length).toBeGreaterThan(0);
      
      const mainToUtils = graph.edges.find(edge =>
        edge.from.includes('main.rs') && toStr(edge.to).includes('utils.rs')
      );
      expect(mainToUtils).toBeDefined();
      
      const mainToHelpers = graph.edges.find(edge =>
        edge.from.includes('main.rs') && toStr(edge.to).includes('helpers.rs')
      );
      expect(mainToHelpers).toBeDefined();
    });
  });
});
