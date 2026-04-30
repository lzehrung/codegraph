import { describe, it, expect } from "vitest";
import {
  graphToDOT,
  graphToMermaid,
  graphToDOTSymbols,
  graphToMermaidSymbols,
  graphToDOTSymbolsWithFiles,
  graphToMermaidSymbolsWithFiles,
  type Graph,
  type SymbolGraph,
} from "../src/index.js";

describe("Graph escaping", () => {
  describe("File-level graph", () => {
    it("escapes double quotes in DOT labels", () => {
      const g: Graph = {
        nodes: new Set(['file-"with"-quotes.ts']),
        edges: [],
      };
      const dot = graphToDOT(g);
      expect(dot).toContain('label="file-\\"with\\"-quotes.ts"');
    });

    it("escapes double quotes in Mermaid labels", () => {
      const g: Graph = {
        nodes: new Set(['file-"with"-quotes.ts']),
        edges: [],
      };
      const mer = graphToMermaid(g);
      expect(mer).toContain('["file-#quot;with#quot;-quotes.ts"]');
    });
  });

  describe("Symbol-level graph", () => {
    it("escapes double quotes in DOT symbol labels and edge labels", () => {
      const sg: SymbolGraph = {
        nodes: new Map([["s1", { id: "s1", name: 'sym-"quoted"', file: "f.ts", kind: "class", visibility: "public" }]]),
        edges: [{ from: "s1", to: "s1", label: 'edge-"label"' }],
      };
      const dot = graphToDOTSymbols(sg);
      expect(dot).toContain('label="f.ts:sym-\\"quoted\\""');
      expect(dot).toContain('label="edge-\\"label\\""');
    });

    it("escapes double quotes in Mermaid symbol labels and edge labels", () => {
      const sg: SymbolGraph = {
        nodes: new Map([["s1", { id: "s1", name: 'sym-"quoted"', file: "f.ts", kind: "class", visibility: "public" }]]),
        edges: [{ from: "s1", to: "s1", label: 'edge-"label"' }],
      };
      const mer = graphToMermaidSymbols(sg);
      expect(mer).toContain('["f.ts:sym-#quot;quoted#quot;"]');
      expect(mer).toContain('-- "edge-#quot;label#quot;" -->');
    });
  });

  describe("Symbol-level graph with files", () => {
    it("escapes double quotes in DOT symbol labels and file labels", () => {
      const fg: Graph = {
        nodes: new Set(['file-"quoted".ts']),
        edges: [],
      };
      const sg: SymbolGraph = {
        nodes: new Map([
          ["s1", { id: "s1", name: 'sym-"quoted"', file: 'file-"quoted".ts', kind: "class", visibility: "public" }],
        ]),
        edges: [],
      };
      const dot = graphToDOTSymbolsWithFiles(sg, fg);
      expect(dot).toContain('label="file-\\"quoted\\".ts"');
      expect(dot).toContain('label="file-\\"quoted\\".ts:sym-\\"quoted\\""');
    });

    it("escapes double quotes in Mermaid symbol labels and file labels", () => {
      const fg: Graph = {
        nodes: new Set(['file-"quoted".ts']),
        edges: [],
      };
      const sg: SymbolGraph = {
        nodes: new Map([
          ["s1", { id: "s1", name: 'sym-"quoted"', file: 'file-"quoted".ts', kind: "class", visibility: "public" }],
        ]),
        edges: [],
      };
      const mer = graphToMermaidSymbolsWithFiles(sg, fg);
      expect(mer).toContain('["file-#quot;quoted#quot;.ts"]');
      expect(mer).toContain('["file-#quot;quoted#quot;.ts:sym-#quot;quoted#quot;"]');
    });
  });
});
