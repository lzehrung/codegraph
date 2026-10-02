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
    // Moved: box.rb relocates under lib/, and use.rb's require_relative path updates to match --
    // require_relative names a file, not a declaration in another file
    // (`import-resolution-tables.ts`).
    moved: {
      files: {
        "lib/box.rb": ["class Box", "  def run", "    1", "  end", "end", ""].join("\n"),
        "widget2.rb": ["class Widget2", "  def run", "    -1", "  end", "end", ""].join("\n"),
        "use.rb": ["require_relative 'lib/box'", "", "def call_with_local", "  b = Box.new", "  b.run", "end", ""].join(
          "\n",
        ),
      },
      expected: { file: "lib/box.rb", line: 2, token: "run" },
    },
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
      ].join("\n"),
      "derived.rb": [
        'require_relative "shapes"',
        "",
        "class Derived < Base",
        "  def run",
        "    super + 1",
        "  end",
        "end",
        "",
      ].join("\n"),
    },
    use: { file: "derived.rb", line: 5, token: "super" },
    keywordUse: true,
    expected: { file: "shapes.rb", line: 2, token: "run" },
    decoy: { file: "shapes.rb", line: 8, token: "run" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "derived.rb", fromName: "run" },
  },
];
