import { describe, expect, it } from "vitest";
import { supportById } from "../src/languages.js";
import { getNativeQueryMetadataForSupport, normalizeNativeQueryForSupport } from "../src/native/tree-sitter-native.js";

describe("native query normalization", () => {
  it("keeps queries unchanged for languages without native compatibility hooks", () => {
    const support = supportById("python");
    expect(support).toBeDefined();
    expect(normalizeNativeQueryForSupport(support!, "imports", "(import_statement (dotted_name) @mod) @stmt")).toBe(
      "(import_statement (dotted_name) @mod) @stmt",
    );
  });

  it("normalizes javascript function node queries", () => {
    const support = supportById("js");
    expect(support).toBeDefined();
    const normalized = normalizeNativeQueryForSupport(
      support!,
      "exports",
      "(expression_statement (assignment_expression right: (function) @cjs_fn))",
    );
    expect(normalized).toContain("(function_expression)");
    expect(normalizeNativeQueryForSupport(support!, "exports", support!.queries.exports)).toContain(
      "(method_definition name: (property_identifier) @cjs_export_name) @cjs_fn",
    );
    expect(getNativeQueryMetadataForSupport(support!)).toEqual({
      normalizedQueryKinds: ["exports"],
      skippedQueryKinds: [],
    });
  });

  it("normalizes typescript export queries for native compatibility", () => {
    const support = supportById("ts");
    expect(support).toBeDefined();
    const normalized = normalizeNativeQueryForSupport(support!, "exports", support!.queries.exports);
    expect(normalized).not.toContain("@ts_export_assign");
    expect(normalized).toContain(
      "(export_statement declaration: (class_declaration name: (type_identifier) @name)) @stmt",
    );
    expect(getNativeQueryMetadataForSupport(support!)).toEqual({
      normalizedQueryKinds: ["exports"],
      skippedQueryKinds: [],
    });
  });

  it("normalizes tsx class identifier queries for native compatibility", () => {
    const support = supportById("tsx");
    expect(support).toBeDefined();
    const normalized = normalizeNativeQueryForSupport(
      support!,
      "locals",
      "(class_declaration name: (type_identifier) @name)",
    );
    expect(normalized).toContain("(class_declaration name: (type_identifier) @name)");
    expect(getNativeQueryMetadataForSupport(support!)).toEqual({
      normalizedQueryKinds: ["exports"],
      skippedQueryKinds: [],
    });
  });

  it("leaves scss queries unchanged now that they target the loaded grammar", () => {
    const support = supportById("scss");
    expect(support).toBeDefined();
    expect(normalizeNativeQueryForSupport(support!, "locals", support!.queries.locals)).toBe(support!.queries.locals);
    expect(normalizeNativeQueryForSupport(support!, "exports", support!.queries.exports)).toBe(
      support!.queries.exports,
    );
    expect(getNativeQueryMetadataForSupport(support!)).toEqual({
      normalizedQueryKinds: [],
      skippedQueryKinds: [],
    });
  });

  it("leaves kotlin queries unchanged now that they target tree-sitter-kotlin-ng directly", () => {
    const support = supportById("kotlin");
    expect(support).toBeDefined();
    for (const kind of ["imports", "exports", "locals", "importBindings"] as const) {
      expect(normalizeNativeQueryForSupport(support!, kind, support!.queries[kind])).toBe(support!.queries[kind]);
      // Node names of the previous Kotlin grammar; tree-sitter-kotlin-ng has none of them.
      for (const staleNodeName of ["import_header", "simple_identifier", "type_identifier"]) {
        expect(support!.queries[kind]).not.toContain(staleNodeName);
      }
    }
    // Kotlin imports are read from the syntax tree, so the surviving queries are the ones that name kotlin-ng nodes.
    expect(support!.queries.exports).toContain("(class_declaration name: (identifier) @name)");
    expect(getNativeQueryMetadataForSupport(support!)).toEqual({
      normalizedQueryKinds: [],
      skippedQueryKinds: [],
    });
  });
});
