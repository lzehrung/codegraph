/**
 * Go call-form cells (docs/plans/2026-09-28-unified-name-resolution.md, Step 1). `goOmissions`
 * below states why three forms have no cell.
 */
import type { CallFormOmission, MatrixCell } from "../types.js";

export const goOmissions: readonly CallFormOmission[] = [
  {
    callForm: "self-member-call",
    reason:
      "Go has no `this`/`self` keyword. A method's own receiver is an explicitly named, arbitrarily " +
      'spelled parameter -- the exact mechanism "typed-local-receiver" already exercises -- so the two ' +
      "forms are not distinct in Go.",
  },
  {
    callForm: "static-receiver",
    reason:
      "Go has no type-scoped static method distinct from an ordinary package-level function (covered by " +
      '"qualified-call") or a value-receiver method (covered by "typed-local-receiver"); there is no third form.',
  },
  {
    callForm: "overload-arity",
    reason:
      "Go rejects two function or method declarations with the same name in the same scope, so " +
      "argument-count overloading is not expressible.",
  },
];

export const goCells: MatrixCell[] = [
  {
    id: "go/bare-call",
    language: "go",
    callForm: "bare-call",
    files: {
      "calc.go": [
        "package main",
        "",
        "func add(a, b int) int {",
        "\treturn a + b",
        "}",
        "",
        "func sumPair() int {",
        "\treturn add(1, 2)",
        "}",
        "",
      ].join("\n"),
      "decoy.go": ["package decoy", "", "func add(a, b int) int {", "\treturn -1", "}", ""].join("\n"),
    },
    use: { file: "calc.go", line: 8, token: "add" },
    expected: { file: "calc.go", line: 3, token: "add" },
    decoy: { file: "decoy.go", line: 3, token: "add" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "calc.go", fromName: "sumPair" },
  },
  {
    id: "go/qualified-call",
    language: "go",
    callForm: "qualified-call",
    files: {
      "go.mod": ["module example.com/m", "", "go 1.21", ""].join("\n"),
      "calc/calc.go": ["package calc", "", "func Add(a, b int) int {", "\treturn a + b", "}", ""].join("\n"),
      "otherpkg/otherpkg.go": ["package otherpkg", "", "func Add(a, b int) int {", "\treturn -1", "}", ""].join("\n"),
      "use/use.go": [
        "package use",
        "",
        'import "example.com/m/calc"',
        "",
        "func SumPair() int {",
        "\treturn calc.Add(1, 2)",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "use/use.go", line: 6, token: "Add" },
    expected: { file: "calc/calc.go", line: 3, token: "Add" },
    decoy: { file: "otherpkg/otherpkg.go", line: 3, token: "Add" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use/use.go", fromName: "SumPair" },
    // Moved: Add relocates to another file of the same package ("calc", same directory); Go's
    // package is an implicit compilation unit (`import-resolution-tables.ts`), so the import and
    // the qualified call in use/use.go need no change at all.
    moved: {
      files: {
        "go.mod": ["module example.com/m", "", "go 1.21", ""].join("\n"),
        "calc/implementation.go": ["package calc", "", "func Add(a, b int) int {", "\treturn a + b", "}", ""].join(
          "\n",
        ),
        "otherpkg/otherpkg.go": ["package otherpkg", "", "func Add(a, b int) int {", "\treturn -1", "}", ""].join("\n"),
        "use/use.go": [
          "package use",
          "",
          'import "example.com/m/calc"',
          "",
          "func SumPair() int {",
          "\treturn calc.Add(1, 2)",
          "}",
          "",
        ].join("\n"),
      },
      expected: { file: "calc/implementation.go", line: 3, token: "Add" },
    },
  },
  {
    id: "go/construction",
    language: "go",
    callForm: "construction",
    files: {
      "widget.go": ["package main", "", "type Widget struct {", "}", ""].join("\n"),
      "decoy.go": ["package main", "", "type Decoy struct {", "}", ""].join("\n"),
      "use.go": ["package main", "", "func makeWidget() Widget {", "\treturn Widget{}", "}", ""].join("\n"),
    },
    use: { file: "use.go", line: 4, token: "Widget" },
    expected: { file: "widget.go", line: 3, token: "Widget" },
    decoy: { file: "decoy.go", line: 3, token: "Decoy" },
    decoyKind: "type",
    edge: { label: "instantiates", fromFile: "use.go", fromName: "makeWidget" },
  },
  {
    id: "go/imported-alias",
    language: "go",
    callForm: "imported-alias",
    files: {
      "go.mod": ["module example.com/m", "", "go 1.21", ""].join("\n"),
      "calc/calc.go": ["package calc", "", "func Add(a, b int) int {", "\treturn a + b", "}", ""].join("\n"),
      "decoypkg/decoypkg.go": ["package decoypkg", "", "func Add(a, b int) int {", "\treturn -1", "}", ""].join("\n"),
      "use/use.go": [
        "package use",
        "",
        'import mathalias "example.com/m/calc"',
        "",
        "func SumPair() int {",
        "\treturn mathalias.Add(1, 2)",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "use/use.go", line: 6, token: "Add" },
    expected: { file: "calc/calc.go", line: 3, token: "Add" },
    decoy: { file: "decoypkg/decoypkg.go", line: 3, token: "Add" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use/use.go", fromName: "SumPair" },
  },
  {
    id: "go/typed-local-receiver",
    language: "go",
    callForm: "typed-local-receiver",
    files: {
      "box.go": ["package main", "", "type Box struct{}", "", "func (b Box) Run() int {", "\treturn 1", "}", ""].join(
        "\n",
      ),
      "widget2.go": [
        "package main",
        "",
        "type Widget2 struct{}",
        "",
        "func (w Widget2) Run() int {",
        "\treturn -1",
        "}",
        "",
      ].join("\n"),
      "use.go": ["package main", "", "func callWithLocal() int {", "\tb := Box{}", "\treturn b.Run()", "}", ""].join(
        "\n",
      ),
    },
    use: { file: "use.go", line: 5, token: "Run" },
    expected: { file: "box.go", line: 5, token: "Run" },
    decoy: { file: "widget2.go", line: 5, token: "Run" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use.go", fromName: "callWithLocal" },
  },
  {
    id: "go/inherited-member",
    language: "go",
    callForm: "inherited-member",
    files: {
      "shapes.go": [
        "package main",
        "",
        "type Base struct{}",
        "",
        "func (Base) Run() int {",
        "\treturn 1",
        "}",
        "",
        "type Decoy struct{}",
        "",
        "func (Decoy) Run() int {",
        "\treturn -1",
        "}",
        "",
        "type Derived struct {",
        "\tBase",
        "}",
        "",
      ].join("\n"),
      "use.go": ["package main", "", "func callDerived() int {", "\td := Derived{}", "\treturn d.Run()", "}", ""].join(
        "\n",
      ),
    },
    use: { file: "use.go", line: 5, token: "Run" },
    expected: { file: "shapes.go", line: 5, token: "Run" },
    decoy: { file: "shapes.go", line: 11, token: "Run" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use.go", fromName: "callDerived" },
  },
  {
    id: "go/super-call",
    language: "go",
    callForm: "super-call",
    files: {
      "shapes.go": [
        "package main",
        "",
        "type Base struct{}",
        "",
        "func (Base) Run() int {",
        "\treturn 1",
        "}",
        "",
        "type Decoy struct{}",
        "",
        "func (Decoy) Run() int {",
        "\treturn -1",
        "}",
        "",
        "type Derived struct {",
        "\tBase",
        "}",
        "",
        "func (d Derived) CallBase() int {",
        "\treturn d.Base.Run() + 1",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "shapes.go", line: 20, token: "Run" },
    expected: { file: "shapes.go", line: 5, token: "Run" },
    decoy: { file: "shapes.go", line: 11, token: "Run" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "shapes.go", fromName: "CallBase" },
  },
];
