/**
 * Ruby call-form cells (docs/plans/2026-09-28-unified-name-resolution.md, Step 1).
 * "overload-arity" is omitted: a later `def` of the same name replaces the earlier one (the same
 * reason as Python), so argument-count overloading is not expressible.
 * "imported-alias" is omitted: `require`/`require_relative` bind no local name, so there is no
 * import-renaming syntax. The closest approximation, reassigning a constant to another module
 * (`CircleArea = Shapes`), does not resolve a member call through the alias at all (confirmed:
 * `CircleArea.area(2)` returns not_found even though `Shapes.area(2)` resolves), so it is not a
 * reliable ordinary-code form to test.
 */
import type { MatrixCell } from "../types.js";

export const rubyCells: MatrixCell[] = [
  {
    id: "ruby/bare-call",
    language: "ruby",
    callForm: "bare-call",
    files: {
      "calc.rb": ["def add(a, b)", "  a + b", "end", "", "def sum_pair", "  add(1, 2)", "end", ""].join("\n"),
      "decoy.rb": ["def add(a, b)", "  -1", "end", ""].join("\n"),
    },
    use: { file: "calc.rb", line: 6, token: "add" },
    expected: { file: "calc.rb", line: 1, token: "add" },
    decoy: { file: "decoy.rb", line: 1, token: "add" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "calc.rb", fromName: "sum_pair" },
  },
  {
    id: "ruby/self-member-call",
    language: "ruby",
    callForm: "self-member-call",
    files: {
      "widget.rb": [
        "class Widget",
        "  def run",
        "    self.helper",
        "  end",
        "",
        "  def helper",
        "    1",
        "  end",
        "end",
        "",
      ].join("\n"),
      "decoy.rb": ["class Other", "  def helper", "    -1", "  end", "end", ""].join("\n"),
    },
    use: { file: "widget.rb", line: 3, token: "helper" },
    expected: { file: "widget.rb", line: 6, token: "helper" },
    decoy: { file: "decoy.rb", line: 2, token: "helper" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "widget.rb", fromName: "run" },
  },
  {
    id: "ruby/typed-local-receiver",
    language: "ruby",
    callForm: "typed-local-receiver",
    files: {
      "box.rb": ["class Box", "  def run", "    1", "  end", "end", ""].join("\n"),
      "widget2.rb": ["class Widget2", "  def run", "    -1", "  end", "end", ""].join("\n"),
      "use.rb": ["require_relative 'box'", "", "def call_with_local", "  b = Box.new", "  b.run", "end", ""].join("\n"),
    },
    use: { file: "use.rb", line: 5, token: "run" },
    expected: { file: "box.rb", line: 2, token: "run" },
    decoy: { file: "widget2.rb", line: 2, token: "run" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use.rb", fromName: "call_with_local" },
  },
  {
    id: "ruby/construction",
    language: "ruby",
    callForm: "construction",
    files: {
      "widget.rb": ["class Widget", "end", ""].join("\n"),
      "decoy.rb": ["class Decoy", "end", ""].join("\n"),
      "use.rb": ["require_relative 'widget'", "", "def make_widget", "  Widget.new", "end", ""].join("\n"),
    },
    use: { file: "use.rb", line: 4, token: "Widget" },
    expected: { file: "widget.rb", line: 1, token: "Widget" },
    decoy: { file: "decoy.rb", line: 1, token: "Decoy" },
    decoyKind: "type",
    edge: { label: "instantiates", fromFile: "use.rb", fromName: "make_widget" },
  },
  {
    id: "ruby/qualified-call",
    language: "ruby",
    callForm: "qualified-call",
    files: {
      "calc.rb": ["module Calc", "  def self.add(a, b)", "    a + b", "  end", "end", ""].join("\n"),
      "decoy.rb": ["module Decoy", "  def self.add(a, b)", "    -1", "  end", "end", ""].join("\n"),
      "use.rb": ["require_relative 'calc'", "", "def sum_pair", "  Calc.add(1, 2)", "end", ""].join("\n"),
    },
    use: { file: "use.rb", line: 4, token: "add" },
    expected: { file: "calc.rb", line: 2, token: "add" },
    decoy: { file: "decoy.rb", line: 2, token: "add" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use.rb", fromName: "sum_pair" },
    knownGap: {
      reason:
        "a module-qualified call to a `self.`-defined singleton method through a bare module-name receiver " +
        "(`Calc.add(1, 2)`) resolves correctly via goToDefinition, but the detailed graph's receiver-call " +
        "classifier never treats a plain Ruby constant as a named-type receiver (only `Constant.new` " +
        "construction is a proven Ruby receiver), so it records no `calls` edge at all for the site",
      classification: "common-code-miss",
      repro:
        "calc.rb: `module Calc; def self.add(a, b); a + b; end; end`; use.rb (after `require_relative`) " +
        "calls `Calc.add(1, 2)`. Current: goToDefinition resolves to Calc.add (correct), but " +
        "buildSymbolGraphDetailed reports zero `calls` edges from sum_pair (only generic `uses` edges to " +
        "Calc and to add). Expected: a `calls` edge from sum_pair to Calc.add.",
    },
  },
  {
    id: "ruby/static-receiver",
    language: "ruby",
    callForm: "static-receiver",
    files: {
      "counter.rb": ["class Counter", "  def self.zero", "    0", "  end", "end", ""].join("\n"),
      "gauge.rb": ["class Gauge", "  def self.zero", "    -1", "  end", "end", ""].join("\n"),
      "use.rb": ["require_relative 'counter'", "", "def make_counter", "  Counter.zero", "end", ""].join("\n"),
    },
    use: { file: "use.rb", line: 4, token: "zero" },
    expected: { file: "counter.rb", line: 2, token: "zero" },
    decoy: { file: "gauge.rb", line: 2, token: "zero" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use.rb", fromName: "make_counter" },
    knownGap: {
      reason:
        "the same gap as ruby/qualified-call: a class-method call through a bare class-name receiver " +
        "(`Counter.zero`) resolves correctly via goToDefinition but produces no `calls` edge",
      classification: "common-code-miss",
      repro:
        "counter.rb: `class Counter; def self.zero; 0; end; end`; use.rb (after `require_relative`) calls " +
        "`Counter.zero`. Current: goToDefinition resolves to Counter.zero (correct), but " +
        "buildSymbolGraphDetailed reports zero `calls` edges from make_counter (only generic `uses` edges). " +
        "Expected: a `calls` edge from make_counter to Counter.zero.",
    },
  },
  {
    id: "ruby/inherited-member",
    language: "ruby",
    callForm: "inherited-member",
    files: {
      "shapes.rb": ["class Base", "  def run", "    1", "  end", "end", "", "class Derived < Base", "end", ""].join(
        "\n",
      ),
      "decoy.rb": ["class Decoy", "  def run", "    -1", "  end", "end", ""].join("\n"),
      "use.rb": ["require_relative 'shapes'", "", "def call_derived", "  d = Derived.new", "  d.run", "end", ""].join(
        "\n",
      ),
    },
    use: { file: "use.rb", line: 5, token: "run" },
    expected: { file: "shapes.rb", line: 2, token: "run" },
    decoy: { file: "decoy.rb", line: 2, token: "run" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "use.rb", fromName: "call_derived" },
    knownGap: {
      reason:
        "a typed-local receiver of a derived class that adds no members of its own does not find a member " +
        "declared only on the base class (the same cross-language gap as C++, PHP, C#, Kotlin, Java, Swift, " +
        "TypeScript, and JavaScript)",
      classification: "common-code-miss",
      repro:
        "shapes.rb: `class Base; def run; 1; end; end` and `class Derived < Base; end`; use.rb calls `d = " +
        "Derived.new; d.run`. Current: goToDefinition on `run` returns not_found. Unlike the other languages " +
        "sharing this gap, the detailed graph's own receiver-call resolver already finds the right target " +
        "here (a `calls` edge from call_derived to Base.run exists), so the graph is ahead of " +
        "go-to-definition for Ruby specifically. Expected: resolves to Base.run.",
    },
  },
  {
    id: "ruby/super-call",
    language: "ruby",
    callForm: "super-call",
    files: {
      "shapes.rb": [
        "class Base",
        "  def run",
        "    1",
        "  end",
        "end",
        "",
        "class Decoy",
        "  def run",
        "    -1",
        "  end",
        "end",
        "",
        "class Derived < Base",
        "  def call_base",
        "    super + 1",
        "  end",
        "end",
        "",
      ].join("\n"),
    },
    use: { file: "shapes.rb", line: 15, token: "super" },
    expected: { file: "shapes.rb", line: 2, token: "run" },
    decoy: { file: "shapes.rb", line: 8, token: "run" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "shapes.rb", fromName: "call_base" },
    knownGap: {
      reason:
        "Ruby's bare `super` -- forwarding the enclosing method's own arguments to the same-named method on " +
        "the superclass, with no explicit method name to navigate -- is not resolved at all",
      classification: "common-code-miss",
      repro:
        "shapes.rb: `class Base; def run; 1; end; end` and `class Derived < Base; def call_base; super + 1; " +
        "end; end`. Current: goToDefinition on the `super` keyword in `super + 1` returns not_found, and the " +
        "detailed graph records no edge from call_base. Expected: resolves to Base.run, with a `calls` edge " +
        "from call_base.",
    },
  },
];
