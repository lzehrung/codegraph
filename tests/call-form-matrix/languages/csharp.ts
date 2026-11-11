/** C# call-form cells (docs/plans/2026-09-28-unified-name-resolution.md, Step 1). */
import type { CallFormOmission, MatrixCell } from "../types.js";
import {
  CSHARP_ALIAS_BOUNDARIES,
  csharpAliasBoundaryFixture,
  csharpAliasTypeFixture,
  CSHARP_ALIAS_TYPE_FORMS,
} from "../../helpers/csharp-alias-shadow-fixture.js";
import {
  CSHARP_NEARER_RECEIVER_CASES,
  csharpNearerReceiverFixture,
  CSHARP_QUALIFIED_RECEIVER_TYPES,
  csharpQualifiedReceiverFixture,
} from "../../helpers/csharp-qualified-receiver-fixture.js";
import {
  CSHARP_ALIAS_CALL_SPELLINGS,
  CSHARP_GENERIC_ALIAS_CASES,
  csharpAliasCallFixture,
  csharpGenericAliasReceiverFixture,
} from "../../helpers/csharp-alias-call-fixture.js";
import {
  CSHARP_INHERITED_ALIAS_CALL_CASES,
  csharpInheritedAliasCase,
} from "../../helpers/csharp-inherited-alias-fixture.js";
import { typeParameterReceiverCell } from "../../helpers/type-parameter-receiver-fixture.js";
import {
  CSHARP_DOTTED_USING_CASES,
  csharpPartialGenericRootFixture,
} from "../../helpers/csharp-dotted-using-fixture.js";
import {
  CSHARP_INSTANTIATED_RECEIVER_SCOPES,
  csharpInstantiatedReceiverFixture,
} from "../../helpers/csharp-instantiated-receiver-fixture.js";

/** Every call form has a cell; nothing is omitted. */
export const csharpOmissions: readonly CallFormOmission[] = [];

const inheritedAliasCell = (caseName: string, id: string, outcome: "alias" | "member" | "unresolved"): MatrixCell => {
  const testCase = csharpInheritedAliasCase(caseName);
  const base = {
    id: `csharp/alias-${id}`,
    language: "csharp" as const,
    callForm: "imported-alias" as const,
    files: testCase.files,
    use: { file: "Use.cs", line: testCase.line, token: "Run" },
    decoyKind: "callable" as const,
    edge: { label: "calls" as const, fromFile: "Use.cs", fromName: "F" },
  };
  if (outcome === "alias") {
    return {
      ...base,
      expected: { file: "N.cs", line: 1, token: "Run" },
      decoy: { file: "Decoy.cs", line: 1, token: "Run" },
    };
  }
  const decoy = { file: "N.cs", line: 1, token: "Run" };
  if (outcome === "member") {
    return { ...base, expected: { file: "Decoy.cs", line: 1, token: "Run" }, decoy };
  }
  return { ...base, expected: "not_found", decoy, decoyAmbiguous: true };
};

const partialGenericRoot = csharpPartialGenericRootFixture();

export const csharpCells: MatrixCell[] = [
  ...CSHARP_INSTANTIATED_RECEIVER_SCOPES.flatMap((scope) => {
    const fixture = csharpInstantiatedReceiverFixture(scope);
    return fixture.sites.map((site): MatrixCell => {
      const targetIndex = ["Prompt.cs", "Pair.cs", "Plain.cs"].indexOf(site.target);
      const target = fixture.targets[targetIndex]!;
      const decoy = fixture.targets[targetIndex === 2 ? 0 : 2]!;
      return {
        id: `csharp/instantiated-receiver-${scope}-${site.caller.toLowerCase()}`,
        language: "csharp",
        callForm: "typed-local-receiver",
        files: fixture.files,
        use: { file: "Use.cs", line: site.line, token: "Count" },
        expected: { file: target.file, line: target.line, token: "Count" },
        decoy: { file: decoy.file, line: decoy.line, token: "Count" },
        decoyKind: "callable",
        edge: { label: "calls", fromFile: "Use.cs", fromName: site.caller },
      };
    });
  }),
  {
    id: "csharp/dotted-root-partial-owner-type-parameter",
    language: "csharp",
    callForm: "static-receiver",
    files: partialGenericRoot.files,
    use: { file: "Use.cs", line: partialGenericRoot.genericLine, token: "Run" },
    expected: "not_found",
    decoy: { file: "Part.cs", line: 1, token: "Run" },
    decoyKind: "callable",
    decoyAmbiguous: true,
    edge: { label: "calls", fromFile: "Use.cs", fromName: "Generic" },
  },
  ...CSHARP_DOTTED_USING_CASES.map(
    (testCase): MatrixCell => ({
      id: `csharp/dotted-root-${testCase.name.replaceAll(" ", "-")}`,
      language: "csharp",
      callForm: "static-receiver",
      files: testCase.files,
      use: { file: "Use.cs", line: testCase.callLine, token: "Run" },
      expected: testCase.target ? { file: testCase.target, line: 1, token: "Run" } : "not_found",
      decoy: { file: testCase.target === "Decoy.cs" ? "NB.cs" : "Decoy.cs", line: 1, token: "Run" },
      decoyKind: "callable",
      decoyAmbiguous: testCase.ambiguous || !testCase.target,
      edge: { label: "calls", fromFile: "Use.cs", fromName: "M" },
    }),
  ),
  // Enclosing project members precede aliases; external members are outside the index.
  inheritedAliasCell("inherited field", "yields-to-inherited-field", "member"),
  inheritedAliasCell("inherited field declared in another file", "yields-to-inherited-field-in-another-file", "member"),
  inheritedAliasCell("external base class", "kept-beside-external-base", "alias"),
  inheritedAliasCell("qualified project base", "kept-beside-empty-qualified-base", "alias"),
  inheritedAliasCell("qualified project base field", "yields-to-qualified-base-field", "member"),
  ...CSHARP_INHERITED_ALIAS_CALL_CASES.map(
    (testCase): MatrixCell => ({
      id: `csharp/alias-${testCase.name.replaceAll(" ", "-")}`,
      language: "csharp",
      callForm: "overload-arity",
      files: testCase.files,
      use: { file: "Use.cs", line: 2, token: "A" },
      expected: testCase.outcome === "base" ? { file: "Base.cs", line: 2, token: "A" } : "not_found",
      decoy: { file: "Mid.cs", line: 2, token: "A" },
      decoyKind: "callable",
      decoyAmbiguous: testCase.outcome === "unresolved",
      edge: { label: "calls", fromFile: "Use.cs", fromName: "F" },
    }),
  ),
  inheritedAliasCell("private field of a base", "kept-beside-private-base-field", "alias"),
  ...CSHARP_GENERIC_ALIAS_CASES.map(({ alias, parameter, scope }): MatrixCell => {
    const fixture = csharpGenericAliasReceiverFixture(alias, parameter, scope);
    return {
      id: `csharp/generic-alias-${alias}-${parameter}-${scope}`,
      language: "csharp",
      callForm: "imported-alias",
      files: fixture.files,
      use: { file: "Use.cs", line: fixture.shadowedCalls[0]!, token: "Run" },
      expected: "not_found",
      decoy: { file: "Target.cs", line: 1, token: "Run" },
      decoyKind: "callable",
      decoyAmbiguous: true,
      edge: { label: "calls", fromFile: "Use.cs", fromName: "Shadowed" },
    };
  }),
  ...CSHARP_NEARER_RECEIVER_CASES.map(({ root, scope }): MatrixCell => {
    const fixture = csharpNearerReceiverFixture(root, scope);
    return {
      id: `csharp/nearer-receiver-${root}-${scope}`,
      language: "csharp",
      callForm: "typed-local-receiver",
      files: fixture.files,
      use: { file: "Use.cs", line: fixture.calls[0]!, token: "Run" },
      expected: fixture.target ? { ...fixture.declaration, token: "Run" } : "not_found",
      decoy: { file: "Global.cs", line: 1, token: "Run" },
      decoyKind: "callable",
      decoyAmbiguous: !fixture.target,
      edge: { label: "calls", fromFile: "Use.cs", fromName: "Parameter" },
    };
  }),
  ...CSHARP_ALIAS_CALL_SPELLINGS.flatMap((alias, aliasIndex) => {
    const fixture = csharpAliasCallFixture(alias);
    // The matrix's absent-edge assertion is caller-wide; Restored legitimately calls both types.
    const singleTargetSites = fixture.sites.filter((site) => site.caller !== "Restored");
    return singleTargetSites.map(
      (site): MatrixCell => ({
        id: `csharp/lowercase-alias-${aliasIndex}-${site.line}`,
        language: "csharp",
        callForm: "imported-alias",
        files: fixture.files,
        use: { file: "Use.cs", line: site.line, token: "Run" },
        expected: { file: site.target, line: 1, token: "Run" },
        decoy: { file: site.target === "Target.cs" ? "Decoy.cs" : "Target.cs", line: 1, token: "Run" },
        decoyKind: "callable",
        edge: { label: "calls", fromFile: "Use.cs", fromName: site.caller },
      }),
    );
  }),
  ...CSHARP_QUALIFIED_RECEIVER_TYPES.flatMap((type, typeIndex) => {
    const fixture = csharpQualifiedReceiverFixture(type);
    return fixture.calls.map(
      (line, proofIndex): MatrixCell => ({
        id: `csharp/qualified-receiver-${typeIndex}-${proofIndex}`,
        language: "csharp",
        callForm: "typed-local-receiver",
        files: fixture.files,
        use: { file: "Use.cs", line, token: "Run" },
        expected: { file: "Value.cs", line: 1, token: "Run" },
        decoy: { file: "Other.cs", line: 1, token: "Run" },
        decoyKind: "callable",
        edge: { label: "calls", fromFile: "Use.cs", fromName: ["Declared", "Constructed", "Parameter"][proofIndex]! },
      }),
    );
  }),
  ...CSHARP_ALIAS_BOUNDARIES.map((boundary): MatrixCell => {
    const fixture = csharpAliasBoundaryFixture(boundary);
    const nestedType = boundary.name === "nested type";
    return {
      id: `csharp/alias-shadow-${boundary.name.replaceAll(" ", "-")}`,
      language: "csharp",
      callForm: "imported-alias",
      files: fixture.files,
      use: { file: "Use.cs", line: fixture.shadowed, token: "Run" },
      expected: nestedType ? { file: "Use.cs", line: 3, token: "Run" } : "not_found",
      decoy: { file: "Second.cs", line: 1, token: "Run" },
      decoyKind: "callable",
      decoyAmbiguous: !nestedType,
      edge: { label: "calls", fromFile: "Use.cs", fromName: "Shadowed" },
    };
  }),
  {
    id: "csharp/alias-construction-beside-value",
    language: "csharp",
    callForm: "construction",
    files: csharpAliasTypeFixture(CSHARP_ALIAS_TYPE_FORMS[1]).files,
    use: { file: "Use.cs", line: 4, token: "B" },
    expected: { file: "Second.cs", line: 1, token: "Second" },
    decoy: { file: "Decoy.cs", line: 1, token: "Second" },
    decoyKind: "type",
    edge: { label: "instantiates", fromFile: "Use.cs", fromName: "Types" },
  },
  {
    id: "csharp/bare-call",
    language: "csharp",
    callForm: "bare-call",
    files: {
      "calc.cs": [
        "public class Calc {",
        "  public int Add(int a, int b) {",
        "    return a + b;",
        "  }",
        "  public int SumPair() {",
        "    return Add(1, 2);",
        "  }",
        "}",
        "",
      ].join("\n"),
      "other.cs": ["public class Other {", "  public int Add(int a, int b) {", "    return -1;", "  }", "}", ""].join(
        "\n",
      ),
    },
    use: { file: "calc.cs", line: 6, token: "Add" },
    expected: { file: "calc.cs", line: 2, token: "Add" },
    decoy: { file: "other.cs", line: 2, token: "Add" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "calc.cs", fromName: "SumPair" },
  },
  {
    id: "csharp/qualified-call",
    language: "csharp",
    callForm: "qualified-call",
    files: {
      "util.cs": [
        "namespace Some.Namespace {",
        "  public class Util {",
        "    public static int Add(int a, int b) { return a + b; }",
        "  }",
        "}",
        "namespace Other.Namespace {",
        "  public class Util {",
        "    public static int Add(int a, int b) { return -1; }",
        "  }",
        "}",
        "",
      ].join("\n"),
      "use.cs": [
        "public class Program {",
        "  public int SumPair() {",
        "    return Some.Namespace.Util.Add(1, 2);",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "use.cs", line: 3, token: "Add" },
    expected: { file: "util.cs", line: 3, token: "Add" },
    decoy: { file: "util.cs", line: 8, token: "Add" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use.cs", fromName: "SumPair" },
    // Moved: Some.Namespace.Util relocates to its own file; C#'s namespace is an implicit
    // compilation unit (`import-resolution-tables.ts`), and use.cs names the type by its fully
    // qualified name, so it needs no change at all -- only util.cs's internal layout changes.
    moved: {
      files: {
        "util.cs": [
          "namespace Other.Namespace {",
          "  public class Util {",
          "    public static int Add(int a, int b) { return -1; }",
          "  }",
          "}",
          "",
        ].join("\n"),
        "util-moved.cs": [
          "namespace Some.Namespace {",
          "  public class Util {",
          "    public static int Add(int a, int b) { return a + b; }",
          "  }",
          "}",
          "",
        ].join("\n"),
        "use.cs": [
          "public class Program {",
          "  public int SumPair() {",
          "    return Some.Namespace.Util.Add(1, 2);",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
      expected: { file: "util-moved.cs", line: 3, token: "Add" },
      decoy: { file: "util.cs", line: 3, token: "Add" },
    },
  },
  {
    id: "csharp/self-member-call",
    language: "csharp",
    callForm: "self-member-call",
    files: {
      "widget.cs": [
        "public class Widget {",
        "  public int Run() {",
        "    return this.Helper();",
        "  }",
        "  public int Helper() {",
        "    return 1;",
        "  }",
        "}",
        "",
      ].join("\n"),
      "other.cs": ["public class Other {", "  public int Helper() {", "    return -1;", "  }", "}", ""].join("\n"),
    },
    use: { file: "widget.cs", line: 3, token: "Helper" },
    expected: { file: "widget.cs", line: 5, token: "Helper" },
    decoy: { file: "other.cs", line: 2, token: "Helper" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "widget.cs", fromName: "Run" },
  },
  {
    id: "csharp/typed-local-receiver",
    language: "csharp",
    callForm: "typed-local-receiver",
    files: {
      "box.cs": ["public class Box {", "  public int Run() { return 1; }", "}", ""].join("\n"),
      "widget2.cs": ["public class Widget2 {", "  public int Run() { return -1; }", "}", ""].join("\n"),
      "use.cs": [
        "public class Caller {",
        "  public int CallWithLocal() {",
        "    Box b = new Box();",
        "    return b.Run();",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "use.cs", line: 4, token: "Run" },
    expected: { file: "box.cs", line: 2, token: "Run" },
    decoy: { file: "widget2.cs", line: 2, token: "Run" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use.cs", fromName: "CallWithLocal" },
  },
  {
    id: "csharp/verbatim-typed-local-receiver",
    language: "csharp",
    callForm: "typed-local-receiver",
    files: {
      "box.cs": ["public class Box {", "  public int Run() { return 1; }", "}", ""].join("\n"),
      "widget2.cs": ["public class Widget2 {", "  public int Run() { return -1; }", "}", ""].join("\n"),
      "use.cs": [
        "public class Caller {",
        "  public int CallWithLocal() {",
        "    Box @b = new Box();",
        "    return b.Run();",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "use.cs", line: 4, token: "Run" },
    expected: { file: "box.cs", line: 2, token: "Run" },
    decoy: { file: "widget2.cs", line: 2, token: "Run" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use.cs", fromName: "CallWithLocal" },
  },
  {
    id: "csharp/static-receiver",
    language: "csharp",
    callForm: "static-receiver",
    files: {
      "counter.cs": ["public class Counter {", "  public static int Zero() { return 0; }", "}", ""].join("\n"),
      "gauge.cs": ["public class Gauge {", "  public static int Zero() { return -1; }", "}", ""].join("\n"),
      "use.cs": [
        "public class Factory {",
        "  public int MakeCounter() {",
        "    return Counter.Zero();",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "use.cs", line: 3, token: "Zero" },
    expected: { file: "counter.cs", line: 2, token: "Zero" },
    decoy: { file: "gauge.cs", line: 2, token: "Zero" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use.cs", fromName: "MakeCounter" },
  },
  {
    id: "csharp/construction",
    language: "csharp",
    callForm: "construction",
    files: {
      "widget3.cs": ["public class Widget3 {", "}", ""].join("\n"),
      "decoy3.cs": ["public class Decoy3 {", "}", ""].join("\n"),
      "use.cs": [
        "public class Factory2 {",
        "  public Widget3 MakeWidget() {",
        "    return new Widget3();",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "use.cs", line: 3, token: "Widget3" },
    expected: { file: "widget3.cs", line: 1, token: "Widget3" },
    decoy: { file: "decoy3.cs", line: 1, token: "Decoy3" },
    decoyKind: "type",
    edge: { label: "instantiates", fromFile: "use.cs", fromName: "MakeWidget" },
  },
  {
    id: "csharp/imported-alias",
    language: "csharp",
    callForm: "imported-alias",
    files: {
      "calc2.cs": [
        "using Fast = Utilities.Calculator;",
        "",
        "namespace Utilities {",
        "  public class Calculator {",
        "    public static int Add(int a, int b) => a + b;",
        "  }",
        "}",
        "namespace Other {",
        "  public class Calculator {",
        "    public static int Add(int a, int b) => -1;",
        "  }",
        "}",
        "namespace App {",
        "  public class Program {",
        "    public int SumPair() {",
        "      return Fast.Add(1, 2);",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "calc2.cs", line: 16, token: "Add" },
    expected: { file: "calc2.cs", line: 5, token: "Add" },
    decoy: { file: "calc2.cs", line: 10, token: "Add" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "calc2.cs", fromName: "SumPair" },
  },
  {
    id: "csharp/verbatim-alias-plain-use",
    language: "csharp",
    callForm: "imported-alias",
    files: {
      "Api.cs": "namespace Utilities;\npublic class Calculator { public static int Add(int a, int b) => a + b; }\n",
      "Decoy.cs": "namespace Other;\npublic class Fast { public static int Add(int a, int b) => -1; }\n",
      "Use.cs": [
        "using @Fast = Utilities.Calculator;",
        "using Other;",
        "class Caller { int SumPair() { return Fast.Add(1, 2); } }",
      ].join("\n"),
    },
    use: { file: "Use.cs", line: 3, token: "Add" },
    expected: { file: "Api.cs", line: 2, token: "Add" },
    decoy: { file: "Decoy.cs", line: 2, token: "Add" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "Use.cs", fromName: "SumPair" },
  },
  {
    id: "csharp/plain-alias-verbatim-use",
    language: "csharp",
    callForm: "imported-alias",
    files: {
      "Api.cs": "namespace Utilities;\npublic class Calculator { public static int Add(int a, int b) => a + b; }\n",
      "Decoy.cs": "namespace Other;\npublic class Fast { public static int Add(int a, int b) => -1; }\n",
      "Use.cs": [
        "using Fast = Utilities.Calculator;",
        "using Other;",
        "class Caller { int SumPair() { return @Fast.Add(1, 2); } }",
      ].join("\n"),
    },
    use: { file: "Use.cs", line: 3, token: "Add" },
    expected: { file: "Api.cs", line: 2, token: "Add" },
    decoy: { file: "Decoy.cs", line: 2, token: "Add" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "Use.cs", fromName: "SumPair" },
  },
  {
    id: "csharp/verbatim-alias-verbatim-use",
    language: "csharp",
    callForm: "imported-alias",
    files: {
      "Api.cs": "namespace Utilities;\npublic class Calculator { public static int Add(int a, int b) => a + b; }\n",
      "Decoy.cs": "namespace Other;\npublic class Fast { public static int Add(int a, int b) => -1; }\n",
      "Use.cs": [
        "using @Fast = Utilities.Calculator;",
        "using Other;",
        "class Caller { int SumPair() { return @Fast.Add(1, 2); } }",
      ].join("\n"),
    },
    use: { file: "Use.cs", line: 3, token: "Add" },
    expected: { file: "Api.cs", line: 2, token: "Add" },
    decoy: { file: "Decoy.cs", line: 2, token: "Add" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "Use.cs", fromName: "SumPair" },
  },
  {
    id: "csharp/imported-alias-local-shadow",
    language: "csharp",
    callForm: "imported-alias",
    files: {
      "second.cs": "namespace N; public class Second { public class Nested { public static void Run() {} } }\n",
      "use.cs": [
        "using B = N.Second;",
        "class Use {",
        "  void Visible() { B.Nested.Run(); }",
        "  void Shadowed(dynamic B) { B.Nested.Run(); }",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "use.cs", line: 4, token: "Run" },
    expected: "not_found",
    decoy: { file: "second.cs", line: 1, token: "Run" },
    decoyKind: "callable",
    // A dynamic receiver stays unresolved and retains partial reference coverage.
    decoyAmbiguous: true,
    edge: { label: "calls", fromFile: "use.cs", fromName: "Shadowed" },
  },
  {
    id: "csharp/namespace-alias",
    language: "csharp",
    callForm: "imported-alias",
    files: {
      "alias2.cs": [
        "using X = Real;",
        "",
        "namespace Real {",
        "  public class Target {",
        "    public static int Run() => 1;",
        "  }",
        "}",
        "namespace App {",
        "  public class Program {",
        "    public int Use() {",
        "      return X.Target.Run();",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
      "shadow2.cs": [
        "namespace Local.X {",
        "  public class Target {",
        "    public static int Run() => -1;",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "alias2.cs", line: 11, token: "Run" },
    expected: { file: "alias2.cs", line: 5, token: "Run" },
    decoy: { file: "shadow2.cs", line: 3, token: "Run" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "alias2.cs", fromName: "Use" },
  },
  {
    id: "csharp/namespace-alias-shadowed",
    language: "csharp",
    callForm: "imported-alias",
    files: {
      "alias3.cs": [
        "using X = Real;",
        "",
        "namespace Real {",
        "  public class Target {",
        "    public static int Run() => 1;",
        "  }",
        "}",
        "namespace Local.X {",
        "  public class Target {",
        "    public static int Run() => -1;",
        "  }",
        "}",
        "namespace Local {",
        "  public class Program {",
        "    public int Use() {",
        "      return X.Target.Run();",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "alias3.cs", line: 16, token: "Run" },
    expected: "not_found",
    decoy: { file: "alias3.cs", line: 10, token: "Run" },
    decoyKind: "callable",
    // The shadowed use stays unresolved, so the decoy it may bind keeps partial reference coverage.
    decoyAmbiguous: true,
  },
  {
    id: "csharp/overload-arity",
    language: "csharp",
    callForm: "overload-arity",
    files: {
      "calc3.cs": [
        "public class Calc3 {",
        "  public static int Add(int a, int b) => a + b;",
        "  public static int Add(int a, int b, int c) => a + b + c;",
        "}",
        "",
      ].join("\n"),
      "decoy4.cs": [
        "public class Calc3Decoy {",
        "  public static int Add(int a, int b, int c, int d) => -1;",
        "}",
        "",
      ].join("\n"),
      "use.cs": [
        "public class Program2 {",
        "  public int SumTriple() {",
        "    return Calc3.Add(1, 2, 3);",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "use.cs", line: 3, token: "Add" },
    expected: { file: "calc3.cs", line: 3, token: "Add" },
    decoy: { file: "decoy4.cs", line: 2, token: "Add" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use.cs", fromName: "SumTriple" },
  },
  {
    // A second "overload-arity" cell (the report shows the worst status across every cell that
    // shares a language and call form): overload resolution must keep searching past an
    // intermediate ancestor's same-named, wrong-arity method to reach a grandparent's matching
    // overload. `GrandBase` declares `Hit(int)`; `Base : GrandBase` declares a different
    // overload, `Hit()`; `Derived : Base` calls `this.Hit(1)`, which only `GrandBase.Hit`
    // accepts -- including the detailed graph's `calls` edge, via `inheritsMemberOverloads` in
    // `src/indexer/member-selection.ts`.
    id: "csharp/overload-arity-inherited",
    language: "csharp",
    callForm: "overload-arity",
    files: {
      "Grand/GrandBase.cs": [
        "namespace Grand {",
        "  public class GrandBase {",
        "    public int Hit(int x) {",
        "      return x;",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
      "Grand/Base.cs": [
        "namespace Grand {",
        "  public class Base : GrandBase {",
        "    public int Hit() {",
        "      return 0;",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
      "Grand/Derived.cs": [
        "namespace Grand {",
        "  public class Derived : Base {",
        "    public int CallHit() {",
        "      return this.Hit(1);",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "Grand/Derived.cs", line: 4, token: "Hit" },
    expected: { file: "Grand/GrandBase.cs", line: 3, token: "Hit" },
    decoy: { file: "Grand/Base.cs", line: 3, token: "Hit" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "Grand/Derived.cs", fromName: "CallHit" },
  },
  {
    id: "csharp/overload-arity-hidden-override",
    language: "csharp",
    callForm: "overload-arity",
    files: {
      "Base.cs": "public class Base { public virtual int M(int x = 0) => 1; }",
      "Derived.cs": [
        "public class Derived : Base {",
        "  public override int M(int x) => 2;",
        "  public int Invalid() => M();",
        "}",
      ].join("\n"),
    },
    use: { file: "Derived.cs", line: 3, token: "M" },
    expected: { file: "Derived.cs", line: 2, token: "M" },
    decoy: { file: "Base.cs", line: 1, token: "M" },
    decoyKind: "callable",
  },

  {
    id: "csharp/inherited-member",
    language: "csharp",
    callForm: "inherited-member",
    files: {
      "base.cs": [
        "public class Base {",
        "  public int Run() => 1;",
        "}",
        "public class Derived : Base {",
        "}",
        "",
      ].join("\n"),
      "decoy5.cs": ["public class Decoy4 {", "  public int Run() => -1;", "}", ""].join("\n"),
      "use.cs": [
        "public class Program3 {",
        "  public int CallDerived() {",
        "    Derived d = new Derived();",
        "    return d.Run();",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "use.cs", line: 4, token: "Run" },
    expected: { file: "base.cs", line: 2, token: "Run" },
    decoy: { file: "decoy5.cs", line: 2, token: "Run" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use.cs", fromName: "CallDerived" },
  },
  {
    id: "csharp/super-call",
    language: "csharp",
    callForm: "super-call",
    files: {
      "base2.cs": [
        "public class Base2 {",
        "  public virtual int Run() => 1;",
        "}",
        "public class Decoy6 {",
        "  public int Run() => -1;",
        "}",
        "public class Derived2 : Base2 {",
        "  public int CallBase() {",
        "    return base.Run() + 1;",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "base2.cs", line: 9, token: "Run" },
    expected: { file: "base2.cs", line: 2, token: "Run" },
    decoy: { file: "base2.cs", line: 5, token: "Run" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "base2.cs", fromName: "CallBase" },
  },
  {
    id: "csharp/declared-field-chain",
    language: "csharp",
    callForm: "self-member-call",
    files: {
      "chain.cs": [
        "class Repo {",
        "  public int Find() { return 1; }",
        "}",
        "class Decoy {",
        "  public int Find() { return -1; }",
        "}",
        "class Middle { public Repo repo; }",
        "class Host {",
        "  public Middle middle;",
        "  public int Run() { return this.middle.repo.Find(); }",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "chain.cs", line: 10, token: "Find" },
    expected: { file: "chain.cs", line: 2, token: "Find" },
    decoy: { file: "chain.cs", line: 5, token: "Find" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "chain.cs", fromName: "Run" },
  },
  {
    id: "csharp/global-using-static",
    language: "csharp",
    callForm: "bare-call",
    files: {
      "Usings.cs": "global using static N.Tools;\n",
      "Tools.cs": "namespace N;\npublic static class Tools { public static int Run() => 1; }\n",
      "Decoy.cs": "namespace Other;\npublic static class Tools { public static int Run() => -1; }\n",
      "Use.cs": "namespace App;\npublic class Use { public int Call() => Run(); }\n",
    },
    use: { file: "Use.cs", line: 2, token: "Run" },
    expected: { file: "Tools.cs", line: 2, token: "Run" },
    decoy: { file: "Decoy.cs", line: 2, token: "Run" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "Use.cs", fromName: "Call" },
  },
  typeParameterReceiverCell("csharp"),
];
