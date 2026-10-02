/**
 * Zig call-form cells (docs/plans/2026-09-28-unified-name-resolution.md, Step 1).
 * "inherited-member" and "super-call" are omitted: Zig has no inheritance or struct-embedding
 * promotion mechanism; a struct that merely contains a field of another struct type does not gain
 * its methods, and there is no base-type keyword.
 * "overload-arity" is omitted: Zig rejects two declarations with the same name in one container,
 * so argument-count overloading is not expressible.
 */
import type { MatrixCell } from "../types.js";

export const zigCells: MatrixCell[] = [
  {
    id: "zig/bare-call",
    language: "zig",
    callForm: "bare-call",
    files: {
      "calc.zig": [
        "pub fn add(a: i32, b: i32) i32 {",
        "    return a + b;",
        "}",
        "",
        "pub fn sumPair() i32 {",
        "    return add(1, 2);",
        "}",
        "",
      ].join("\n"),
      "decoy.zig": ["fn add(a: i32, b: i32) i32 {", "    return -1;", "}", ""].join("\n"),
    },
    use: { file: "calc.zig", line: 6, token: "add" },
    expected: { file: "calc.zig", line: 1, token: "add" },
    decoy: { file: "decoy.zig", line: 1, token: "add" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "calc.zig", fromName: "sumPair" },
  },
  {
    id: "zig/qualified-call",
    language: "zig",
    callForm: "qualified-call",
    files: {
      "calc.zig": ["pub fn add(a: i32, b: i32) i32 {", "    return a + b;", "}", ""].join("\n"),
      "decoy.zig": ["pub fn add(a: i32, b: i32) i32 {", "    return -1;", "}", ""].join("\n"),
      "use.zig": [
        'const calc = @import("calc.zig");',
        "",
        "pub fn sumPair() i32 {",
        "    return calc.add(1, 2);",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "use.zig", line: 4, token: "add" },
    expected: { file: "calc.zig", line: 1, token: "add" },
    decoy: { file: "decoy.zig", line: 1, token: "add" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use.zig", fromName: "sumPair" },
  },
  {
    id: "zig/self-member-call",
    language: "zig",
    callForm: "self-member-call",
    files: {
      "widget.zig": [
        "pub const Widget = struct {",
        "    pub fn run(self: Widget) i32 {",
        "        return self.helper();",
        "    }",
        "    pub fn helper(self: Widget) i32 {",
        "        return 1;",
        "    }",
        "};",
        "",
      ].join("\n"),
      "decoy.zig": [
        "pub const Other = struct {",
        "    pub fn helper(self: Other) i32 {",
        "        return -1;",
        "    }",
        "};",
        "",
      ].join("\n"),
    },
    use: { file: "widget.zig", line: 3, token: "helper" },
    expected: { file: "widget.zig", line: 5, token: "helper" },
    decoy: { file: "decoy.zig", line: 2, token: "helper" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "widget.zig", fromName: "run" },
  },
  {
    id: "zig/typed-local-receiver",
    language: "zig",
    callForm: "typed-local-receiver",
    files: {
      "box.zig": [
        "pub const Box = struct {",
        "    pub fn run(self: Box) i32 {",
        "        return 1;",
        "    }",
        "};",
        "",
      ].join("\n"),
      "widget2.zig": [
        "pub const Widget2 = struct {",
        "    pub fn run(self: Widget2) i32 {",
        "        return -1;",
        "    }",
        "};",
        "",
      ].join("\n"),
      "use.zig": [
        'const box = @import("box.zig");',
        "",
        "pub fn callWithLocal() i32 {",
        "    const b: box.Box = box.Box{};",
        "    return b.run();",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "use.zig", line: 5, token: "run" },
    expected: { file: "box.zig", line: 2, token: "run" },
    decoy: { file: "widget2.zig", line: 2, token: "run" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use.zig", fromName: "callWithLocal" },
    knownGap: {
      reason:
        'a receiver whose type is a qualified cross-file reference (`const box = @import("box.zig"); const ' +
        "b: box.Box = box.Box{};`) resolves correctly via goToDefinition, but the detailed graph records no " +
        "`calls` edge for the member call -- the same-file form of this call (zig/self-member-call) already " +
        "has edge coverage, so the gap is specific to the cross-file qualified form",
      classification: "common-code-miss",
      repro:
        "box.zig: `pub const Box = struct { pub fn run(self: Box) i32 { return 1; } };`; use.zig: `const box " +
        '= @import("box.zig"); ... const b: box.Box = box.Box{}; return b.run();`. Current: goToDefinition on ' +
        "`run` resolves correctly to box.zig's run, but buildSymbolGraphDetailed reports zero edges from " +
        "callWithLocal for the `.run()` call (only a generic `uses` edge to Box). Expected: a `calls` edge " +
        "from callWithLocal to Box.run.",
    },
  },
  {
    id: "zig/static-receiver",
    language: "zig",
    callForm: "static-receiver",
    files: {
      "counter.zig": [
        "pub const Counter = struct {",
        "    pub fn zero() i32 {",
        "        return 0;",
        "    }",
        "};",
        "",
      ].join("\n"),
      "gauge.zig": [
        "pub const Gauge = struct {",
        "    pub fn zero() i32 {",
        "        return -1;",
        "    }",
        "};",
        "",
      ].join("\n"),
      "use.zig": [
        'const counter = @import("counter.zig");',
        "",
        "pub fn makeCounter() i32 {",
        "    return counter.Counter.zero();",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "use.zig", line: 4, token: "zero" },
    expected: { file: "counter.zig", line: 2, token: "zero" },
    decoy: { file: "gauge.zig", line: 2, token: "zero" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use.zig", fromName: "makeCounter" },
    knownGap: {
      reason:
        "the same gap as zig/typed-local-receiver: a type-scoped call reached through a qualified cross-file " +
        "namespace (`counter.Counter.zero()`) resolves correctly via goToDefinition but produces no `calls` " +
        "edge",
      classification: "common-code-miss",
      repro:
        "counter.zig: `pub const Counter = struct { pub fn zero() i32 { return 0; } };`; use.zig: `const " +
        'counter = @import("counter.zig"); ... return counter.Counter.zero();`. Current: goToDefinition ' +
        "resolves correctly to Counter.zero, but buildSymbolGraphDetailed reports zero `calls` edges from " +
        "makeCounter (only a generic `uses` edge to Counter). Expected: a `calls` edge from makeCounter to " +
        "Counter.zero.",
    },
  },
  {
    id: "zig/construction",
    language: "zig",
    callForm: "construction",
    files: {
      "widget3.zig": ["pub const Widget3 = struct {", "    value: i32 = 0,", "};", ""].join("\n"),
      "decoy3.zig": ["pub const Decoy3 = struct {", "    value: i32 = 0,", "};", ""].join("\n"),
      "use.zig": [
        'const widget3 = @import("widget3.zig");',
        "",
        "pub fn makeWidget() widget3.Widget3 {",
        "    return widget3.Widget3{};",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "use.zig", line: 4, token: "Widget3" },
    expected: { file: "widget3.zig", line: 1, token: "Widget3" },
    decoy: { file: "decoy3.zig", line: 1, token: "Decoy3" },
    decoyKind: "type",
    edge: { label: "instantiates", fromFile: "use.zig", fromName: "makeWidget" },
    knownGap: {
      reason:
        "the same gap as zig/typed-local-receiver and zig/static-receiver: constructing a type reached " +
        "through a qualified cross-file namespace (`widget3.Widget3{}`) resolves correctly via " +
        "goToDefinition but produces no `instantiates` edge",
      classification: "common-code-miss",
      repro:
        "widget3.zig: `pub const Widget3 = struct { value: i32 = 0 };`; use.zig: `const widget3 = " +
        '@import("widget3.zig"); ... return widget3.Widget3{};`. Current: goToDefinition resolves correctly ' +
        "to Widget3's declaration, but buildSymbolGraphDetailed reports zero edges from makeWidget for the " +
        "construction (only a generic `uses` edge). Expected: an `instantiates` edge from makeWidget to " +
        "Widget3.",
    },
  },
  {
    id: "zig/imported-alias",
    language: "zig",
    callForm: "imported-alias",
    files: {
      "shapes.zig": ["pub fn area(radius: f64) f64 {", "    return radius * radius;", "}", ""].join("\n"),
      "decoy.zig": ["pub fn area(radius: f64) f64 {", "    return -1.0;", "}", ""].join("\n"),
      "use.zig": [
        'const circleArea = @import("shapes.zig").area;',
        "",
        "pub fn computeArea() f64 {",
        "    return circleArea(2.0);",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "use.zig", line: 4, token: "circleArea" },
    expected: { file: "shapes.zig", line: 1, token: "area" },
    decoy: { file: "decoy.zig", line: 1, token: "area" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use.zig", fromName: "computeArea" },
    knownGap: {
      reason:
        'a specific-symbol import written as `const circleArea = @import("shapes.zig").area;` resolves to ' +
        "the local alias statement itself rather than continuing to the original declaration -- unlike C#, " +
        "Kotlin, Python, TypeScript, and JavaScript, which all chase an aliased import through to its source",
      classification: "confident-wrong",
      repro:
        "shapes.zig: `pub fn area(radius: f64) f64 { return radius * radius; }`; use.zig: `const circleArea " +
        '= @import("shapes.zig").area; ... return circleArea(2.0);`. Current: goToDefinition on `circleArea` ' +
        "resolves to use.zig's own alias line (status ok, wrong target), not shapes.zig's area; the detailed " +
        "graph's `calls` edge from computeArea follows the same wrong target. Expected: resolves to " +
        "shapes.zig's area.",
    },
  },
];
