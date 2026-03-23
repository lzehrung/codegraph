import { describe, expect, it } from "vitest";
import { supportById } from "../src/languages.js";
import {
  getNativeQueryMetadataForSupport,
  normalizeNativeQueryForSupport,
} from "../src/native/treeSitterNative.js";

describe("native query normalization", () => {
  it("keeps queries unchanged for languages without native compatibility hooks", () => {
    const support = supportById("python");
    expect(support).toBeDefined();
    expect(
      normalizeNativeQueryForSupport(
        support!,
        "imports",
        '(import_statement (dotted_name) @mod) @stmt',
      ),
    ).toBe('(import_statement (dotted_name) @mod) @stmt');
  });

  it("normalizes javascript function node queries", () => {
    const support = supportById("js");
    expect(support).toBeDefined();
    const normalized = normalizeNativeQueryForSupport(
      support!,
      "exports",
      '(expression_statement (assignment_expression right: (function) @cjs_fn))',
    );
    expect(normalized).toContain("(function_expression)");
  });

  it("normalizes typescript export queries for native compatibility", () => {
    const support = supportById("ts");
    expect(support).toBeDefined();
    const normalized = normalizeNativeQueryForSupport(
      support!,
      "exports",
      [
        "(export_assignment (identifier) @ts_export_assign)",
        '(export_statement (class_declaration name: (identifier) @default)) @stmt (#match? @stmt "default")',
      ].join("\n"),
    );
    expect(normalized).not.toContain("@ts_export_assign");
    expect(normalized).not.toContain("@default");
  });

  it("normalizes tsx class identifier queries for native compatibility", () => {
    const support = supportById("tsx");
    expect(support).toBeDefined();
    const normalized = normalizeNativeQueryForSupport(
      support!,
      "exports",
      "(class_declaration name: (identifier) @name)",
    );
    expect(normalized).toContain("(class_declaration name: (type_identifier) @name)");
  });

  it("blanks unsupported scss symbol queries", () => {
    const support = supportById("scss");
    expect(support).toBeDefined();
    expect(
      normalizeNativeQueryForSupport(
        support!,
        "locals",
        "(class_selector (class_name) @name)",
      ),
    ).toBe("");
    expect(getNativeQueryMetadataForSupport(support!)).toEqual({
      normalizedQueryKinds: ["exports", "locals"],
      skippedQueryKinds: ["exports", "locals"],
    });
  });

  it("normalizes kotlin import and identifier node names", () => {
    const support = supportById("kotlin");
    expect(support).toBeDefined();
    const normalized = normalizeNativeQueryForSupport(
      support!,
      "imports",
      "(import_header (simple_identifier) @from)",
    );
    expect(normalized).toContain("(import (identifier) @from)");
  });

  it("blanks unsupported kotlin alias and wildcard import queries", () => {
    const support = supportById("kotlin");
    expect(support).toBeDefined();
    expect(
      normalizeNativeQueryForSupport(
        support!,
        "importBindings",
        "(import_header (identifier) @from (import_alias (type_identifier) @alias)) @stmt",
      ),
    ).toBe("");
    expect(
      normalizeNativeQueryForSupport(
        support!,
        "importBindings",
        "(import_header (identifier) @from (wildcard_import) @wild) @stmt",
      ),
    ).toBe("");
    expect(getNativeQueryMetadataForSupport(support!)).toEqual({
      normalizedQueryKinds: ["imports", "exports", "locals", "importBindings"],
      skippedQueryKinds: ["importBindings"],
    });
  });
});
