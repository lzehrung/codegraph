import { describe, expect, it } from "vitest";
import { supportById } from "../src/languages.js";
import { getNativeQueryMetadataForSupport, normalizeNativeQueryForSupport } from "../src/native/treeSitterNative.js";

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
    expect(normalized).toContain("(export_statement declaration: (class_declaration name: (type_identifier) @name)) @stmt");
    expect(getNativeQueryMetadataForSupport(support!)).toEqual({
      normalizedQueryKinds: ["exports"],
      skippedQueryKinds: [],
    });
  });

  it("normalizes tsx class identifier queries for native compatibility", () => {
    const support = supportById("tsx");
    expect(support).toBeDefined();
    const normalized = normalizeNativeQueryForSupport(support!, "locals", "(class_declaration name: (type_identifier) @name)");
    expect(normalized).toContain("(class_declaration name: (type_identifier) @name)");
    expect(getNativeQueryMetadataForSupport(support!)).toEqual({
      normalizedQueryKinds: ["exports"],
      skippedQueryKinds: [],
    });
  });

  it("blanks unsupported scss symbol queries", () => {
    const support = supportById("scss");
    expect(support).toBeDefined();
    expect(normalizeNativeQueryForSupport(support!, "locals", "(class_selector (class_name) @name)")).toBe("");
    expect(getNativeQueryMetadataForSupport(support!)).toEqual({
      normalizedQueryKinds: ["exports", "locals"],
      skippedQueryKinds: ["exports", "locals"],
    });
  });

  it("normalizes kotlin import and identifier node names", () => {
    const support = supportById("kotlin");
    expect(support).toBeDefined();
    const normalized = normalizeNativeQueryForSupport(support!, "imports", "(import_header (simple_identifier) @from)");
    expect(normalized).toContain("(import (qualified_identifier) @mod) @stmt");
  });

  it("normalizes kotlin import-binding queries without blanking them", () => {
    const support = supportById("kotlin");
    expect(support).toBeDefined();
    expect(
      normalizeNativeQueryForSupport(
        support!,
        "importBindings",
        "(import_header (identifier) @from (import_alias (type_identifier) @alias)) @stmt",
      ),
    ).toContain("(import (qualified_identifier) @from (identifier) @alias) @stmt");
    expect(
      normalizeNativeQueryForSupport(support!, "importBindings", "(import_header (identifier) @from (wildcard_import) @wild) @stmt"),
    ).toContain('(import (qualified_identifier) @from "*" @wild) @stmt');
    expect(getNativeQueryMetadataForSupport(support!)).toEqual({
      normalizedQueryKinds: ["imports", "exports", "locals", "importBindings"],
      skippedQueryKinds: [],
    });
  });
});
