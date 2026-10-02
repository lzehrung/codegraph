/**
 * Go call-form cells (docs/plans/2026-09-28-unified-name-resolution.md, Step 1).
 * "self-member-call" is omitted: Go has no `this`/`self` keyword. A method's own receiver is an
 * explicitly named, arbitrarily spelled parameter -- the exact mechanism "typed-local-receiver"
 * already exercises -- so the two forms are not distinct in Go.
 * "static-receiver" is omitted: Go has no type-scoped static method distinct from an ordinary
 * package-level function (covered by "qualified-call") or a value-receiver method (covered by
 * "typed-local-receiver"); there is no third form.
 * "overload-arity" is omitted: Go rejects two function or method declarations with the same name
 * in the same scope, so argument-count overloading is not expressible.
 */
import type { MatrixCell } from "../types.js";

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
    knownGap: {
      reason:
        "a cross-file method declaration is not found by a receiver call: box.go declares Box.Run, and a " +
        "local `Box{}` receiver constructed in a different file (use.go) cannot resolve `.Run()`, even though " +
        "the identical call resolves when declaration and use share one file",
      classification: "common-code-miss",
      repro:
        "box.go: `type Box struct{}` with `func (b Box) Run() int { return 1 }`; use.go (same package, " +
        "different file): `func callWithLocal() int { b := Box{}; return b.Run() }`. Current: goToDefinition " +
        "on `Run` returns not_found. The detailed graph's own receiver-call resolver still finds the right " +
        "target (a `calls` edge from callWithLocal to Box.Run exists), so this is a navigation-only miss. " +
        "Expected: resolves to Box.Run. Moving the whole example into one file resolves correctly, isolating " +
        "the gap to cross-file receiver lookup.",
    },
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
    knownGap: {
      reason:
        "a promoted method declared through struct embedding is not found across files: shapes.go embeds " +
        "Base in Derived, and a local `Derived{}` constructed in a different file (use.go) cannot resolve " +
        "the promoted `.Run()`, though the identical promoted-method call already has permanent passing " +
        "coverage when declaration and use share one file (tests/samples/go/embedding.go)",
      classification: "common-code-miss",
      repro:
        "shapes.go: `type Base struct{}` with `func (Base) Run() int { return 1 }`, and `type Derived struct " +
        "{ Base }`; use.go (same package, different file) calls `d := Derived{}; d.Run()`. Current: " +
        "goToDefinition on `Run` returns not_found; the detailed graph again finds the right target on its " +
        "own (a `calls` edge from callDerived to Base.Run exists). Expected: resolves to Base.Run. This is " +
        "the same cross-file receiver-lookup gap as go/typed-local-receiver, now shown through struct " +
        "embedding.",
    },
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
    knownGap: {
      reason:
        "an explicit base-qualified call through an embedded field (`d.Base.Run()`) -- Go's way to reach a " +
        "promoted method that a derived type's own same-named method would otherwise shadow -- is not " +
        "resolved at all",
      classification: "common-code-miss",
      repro:
        "shapes.go: `type Base struct{}` with `func (Base) Run() int { return 1 }`, `type Derived struct { " +
        "Base }`, and `func (d Derived) CallBase() int { return d.Base.Run() + 1 }`. Current: goToDefinition " +
        "on the `Run` in `d.Base.Run()` returns not_found, and the detailed graph records no edge at all from " +
        "CallBase (only its own `member_of` edge to Derived). Expected: resolves to Base.Run, with a `calls` " +
        "edge from CallBase.",
    },
  },
];
