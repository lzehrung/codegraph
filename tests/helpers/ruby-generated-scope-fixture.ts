import { expect } from "vitest";
import { buildSymbolGraphDetailed } from "../../src/graphs/symbol-graph-detailed.js";
import { findReferences, goToDefinition, type ProjectIndex } from "../../src/index.js";
import { fileIdentityKey } from "../../src/util/paths.js";

/**
 * Where a generated method (`attr_reader :v`) is and is not reachable by a bare name, by `self`, or by a constant. Every
 * class of a file shares the file scope, so each case below puts the readers and the uses that must not reach them in
 * one file: a sibling class, a singleton method, a `class << self` body, a nested class, and a Struct subclass. Locals,
 * parameters, block and lambda parameters, pattern bindings, and a named regexp capture named like an accessor hide the
 * reader for the rest of their block, and `self.name` reaches it only inside an instance
 * method. A constant receiver (`Acc.ax`) is the class and reaches no generated instance method, while a singleton `def`
 * of the same name does. A `def` of the same name wins in either order. Ruby 3.3 confirms each answer (a name outside
 * its class raises NameError; `self` and a constant in a singleton method are the class; the later of two definitions
 * wins; a local hides the reader from the point it is bound until its block ends).
 * `Device` and `Decoy` repeat one set of names, so typed-local and cross-file calls must pick their own class.
 */
export const RUBY_SCOPE_LINES: Record<string, string[]> = {
  "scope.rb": [
    "class Left",
    "  attr_reader :v",
    "  def read; v; end",
    "end",
    "class Right",
    "  attr_reader :v",
    "  def read; v; end",
    "end",
    "class Plain",
    "  def read; v; self.v; end",
    "end",
    "class Outer",
    "  attr_accessor :w",
    "  def own; w; end",
    "  def self.build; w; end",
    "  class << self",
    "    def meta; w; end",
    "  end",
    "  class Inner",
    "    def inside; w; end",
    "  end",
    "end",
    "class Mirror < Struct.new(:w)",
    "  def read; w; end",
    "end",
    "class Late",
    "  def early; later; end",
    "  attr_reader :later",
    "end",
    "",
  ],
  "locals.rb": [
    "class Locals",
    "  attr_accessor :name, :count, :err, :item",
    "  def initialize(name)",
    "    self.name = name",
    "    @shadow = name",
    "  end",
    "  def multi(io)",
    '    name, rest = io.split(",")',
    "    name",
    "  end",
    "  def compound",
    "    count ||= 3",
    "    count",
    "  end",
    "  def rescued",
    '    begin; raise "x"; rescue => err; end',
    "    err",
    "  end",
    "  def block_param",
    "    [1].map { |name| name }",
    "  end",
    "  def plain_local",
    "    name = 2",
    "    name",
    "  end",
    "  def reader",
    "    name",
    "  end",
    "  def looped",
    "    for item in [1]; end",
    "    item",
    "  end",
    "end",
    "",
  ],
  "order.rb": [
    "class AttrFirst",
    "  attr_reader :ay",
    "  def ay; :def; end",
    "  def go; self.ay; ay; end",
    "end",
    "class DefFirst",
    "  def dy; :def; end",
    "  attr_reader :dy",
    "  def check; self.dy; dy; end",
    "end",
    "class Custom",
    "  attr_accessor :z",
    "  def z=(value); @z = [:custom, value]; end",
    "  def tick; self.z = 1; z; end",
    "end",
    "class OrderProbe",
    "  def probe",
    "    first = AttrFirst.new",
    "    first.ay",
    "    second = DefFirst.new",
    "    second.dy",
    "  end",
    "end",
    "",
  ],
  "receivers.rb": [
    "module ViaModule",
    "  attr_accessor :shut",
    "  def self.extended(obj); obj.shut = false; obj.shut; end",
    "end",
    "module ViaModuleDef",
    "  def lock; end",
    "  def lock=(value); end",
    "  def self.extended(obj); obj.lock = false; obj.lock; end",
    "end",
    "class ViaClass",
    "  attr_accessor :seal",
    "  def self.extended(obj); obj.seal = false; obj.seal; end",
    "end",
    "class ViaClassDef",
    "  def latch; end",
    "  def latch=(value); end",
    "  def self.extended(obj); obj.latch = false; obj.latch; end",
    "end",
    "",
  ],
  "device.rb": [
    "class Device",
    "  attr_accessor :mode",
    "  attr_writer :target",
    "  def label=(value); @label = value; end",
    "  def full?; true; end",
    "  def drain!; end",
    "end",
    "",
  ],
  "decoy.rb": [
    "class Decoy",
    "  attr_accessor :mode",
    "  attr_writer :target",
    "  def label=(value); @label = value; end",
    "  def full?; false; end",
    "  def drain!; end",
    "end",
    "",
  ],
  "operator.rb": [
    'require_relative "device"',
    'require_relative "decoy"',
    "class Operator",
    "  def run",
    "    device = Device.new",
    "    device.mode = 1",
    "    device.mode",
    "    Device.new.mode = 3",
    "    device.target = :t",
    "    device.label = 2",
    "    device.full?",
    "    device.drain!",
    "    device.mode, device.label = 1, 2",
    "    decoy = Decoy.new",
    "    decoy.mode = 1",
    "    decoy.full?",
    "    decoy.drain!",
    "  end",
    "end",
    "",
  ],
  "shadow.rb": [
    "class Shadow",
    "  attr_accessor :k",
    "  def lambda_paren",
    "    ->(k) { k }.call(1)",
    "  end",
    "  def lambda_bare",
    "    -> k { k }.call(2)",
    "  end",
    "  def lambda_default",
    "    ->(a, k = 3) { k }.call(0)",
    "  end",
    "  def lambda_keyword",
    "    ->(k:) { k }.call(k: 4)",
    "  end",
    "  def pattern_array(s)",
    "    case s",
    "    in [k, *]",
    "      k",
    "    end",
    "  end",
    "  def pattern_hash(s)",
    "    case s",
    "    in { k: }",
    "      k",
    "    end",
    "  end",
    "  def pattern_rightward(v)",
    "    v => k",
    "    k",
    "  end",
    "  def pattern_nested(h)",
    "    h => { a: k }",
    "    k",
    "  end",
    "  def pattern_alias(s)",
    "    case s",
    "    in Integer => k if k > 1",
    "      k",
    "    end",
    "  end",
    "  def pattern_splat(s)",
    "    case s",
    "    in [Integer, *k]",
    "      k",
    "    end",
    "  end",
    "  def pattern_rest(s)",
    "    case s",
    "    in { name:, **k }",
    "      k",
    "    end",
    "  end",
    "  def pattern_test(s)",
    "    return k if s in { k: }",
    "    k",
    "  end",
    "  def named_capture(s)",
    "    /(?<k>a)/ =~ s",
    "    k",
    "  end",
    "  def wrap(**options)",
    "    options",
    "  end",
    "  def property_only(other)",
    "    other.k",
    "    self.k = 1",
    "    { k: 2 }",
    "    wrap(k: 3)",
    "    k",
    "  end",
    "end",
    "",
  ],
  "selfs.rb": [
    "class SelfCases",
    "  attr_accessor :lv",
    "  def inst",
    "    self.lv",
    "    self.lv = 1",
    "  end",
    "  def self.single",
    "    self.lv",
    "    self.lv = 2",
    "  end",
    "  class << self",
    "    def meta",
    "      self.lv",
    "    end",
    "  end",
    "  begin",
    "    self.lv",
    "  rescue NoMethodError",
    "  end",
    "  Point = Struct.new(:lv) do",
    "    def show",
    "      lv",
    "      self.lv",
    "    end",
    "  end",
    "end",
    "class SelfSub < SelfCases",
    "  def sub",
    "    self.lv",
    "  end",
    "  def self.klass",
    "    self.lv",
    "  end",
    "end",
    "class SelfOnly",
    "  attr_accessor :ev",
    "  def touch",
    "    self.ev",
    "    self.ev = 1",
    "  end",
    "end",
    "class SelfMeta",
    "  attr_accessor :mv",
    "  def inst2",
    "    self.mv",
    "    self.mv = 1",
    "  end",
    "  class << self",
    "    def meta2",
    "      self.mv",
    "      self.mv = 2",
    "    end",
    "  end",
    "end",
    "",
  ],
  "blocks.rb": [
    "class Blocks",
    "  attr_accessor :limit",
    "  attr_reader :name, :total, :item",
    "  def b1(items)",
    "    items.each { |name| name }",
    "    name",
    "  end",
    "  def b2(items)",
    "    items.each { total = 1 }",
    "    total",
    "  end",
    "  def b3",
    "    ->(item = limit) { item }.call",
    "    limit",
    "  end",
    "  def b4(items)",
    "    items.each do |name|",
    "      name",
    "    end",
    "    name",
    "  end",
    "  def b5",
    "    1.times { limit = 2; limit }",
    "    limit",
    "  end",
    "  class_eval do",
    "    def evaled",
    "      limit",
    "      self.limit = 3",
    "    end",
    "  end",
    "  [1].each do",
    "    def looped_def",
    "      name",
    "      self.name",
    "    end",
    "  end",
    "  S = Struct.new(:x) do",
    "    def struct_def",
    "      limit",
    "      self.limit",
    "    end",
    "  end",
    "  K = Class.new do",
    "    def class_def",
    "      limit",
    "    end",
    "  end",
    "  instance_eval do",
    "    def inst_eval_def",
    "      limit",
    "    end",
    "  end",
    "end",
    "",
  ],
  "statics.rb": [
    "class Acc",
    "  attr_accessor :ax",
    "end",
    "class Config",
    "  attr_accessor :level",
    "  attr_reader :name",
    "  def self.level",
    "    :global",
    "  end",
    "  def self.name",
    '    "cfg"',
    "  end",
    "  def self.build",
    "    Config.level",
    "    self.level",
    "    name",
    "  end",
    "end",
    "class Tool",
    "  attr_accessor :kind",
    "  def self.create",
    "    new",
    "  end",
    "  def run",
    "    Tool.kind",
    "    Tool.kind = 1",
    "    kind",
    "  end",
    "end",
    "class UseStatic",
    "  def m",
    "    Acc.ax",
    "    Acc.ax = 1",
    "    Config.level",
    "    Config.name",
    "  end",
    "end",
    "",
  ],
  "use_statics.rb": [
    'require_relative "statics"',
    "class CrossStatic",
    "  def m",
    "    Acc.ax",
    "    Acc.ax = 1",
    "    Config.level",
    "    Config.name",
    "    Tool.kind",
    "  end",
    "end",
    "",
  ],
  // A visibility call around an attr macro defines the same members; a form the index cannot read defines nothing, so
  // the later same-named methods of `Rival` never bind.
  "wrapped.rb": [
    "class Vault",
    "  private attr_reader :reserve",
    "  protected attr_accessor :cap",
    "  public attr_writer :note",
    "  memoize attr_reader :slot",
    "  private attr_reader(*SLOTS)",
    "  def report = [reserve, cap, slot]",
    "  def stash(value) = (self.note = value)",
    "end",
    "class Rival",
    "  def reserve = 0",
    "  def cap = 0",
    "  def slot = 0",
    "  def note=(value); end",
    "end",
    "",
  ],
  // A call nested in an argument, a receiver chain, or a block calls the same method as one on its own line. A block
  // parameter and a multiple-assignment local named like a method hide it.
  "nested.rb": [
    "class Meter",
    "  def reading = 1",
    "  def pulse = 2",
    "  def emit(value) = value",
    "  def run",
    "    emit(reading)",
    "    puts reading",
    "    emit(pulse())",
    "    emit(self.pulse)",
    "    [1].each { pulse }",
    "    [1].map { |q| q + reading }",
    "  end",
    "  def shadowed",
    "    [1].map { |reading| reading + 1 }",
    "    reading, other = 1, 2",
    "  end",
    "end",
    "class Mimic",
    "  def reading = 0",
    "  def pulse = 0",
    "  def emit(value) = value",
    "end",
    "",
  ],
  // `def`, `class`, and `module` start a scope that reads no local of the code around it, and the locals of a class or
  // module body end with it; a block closes over the locals around it. Ruby 3.3 raises NameError for each unreached read.
  "gates.rb": [
    "top_total = 5",
    "def uses_top_total",
    "  top_total",
    "end",
    "class Stranger",
    "  def top_total = :method",
    "end",
    "class K1",
    "  cx = 1",
    "  p cx",
    "end",
    "class K2",
    "  p cx",
    "end",
    "module M1",
    "  mx = 1",
    "end",
    "module M2",
    "  def read = mx",
    "end",
    "puts top_total",
    "[1].each { |q| puts q + top_total }",
    "",
  ],
  // `Base = Struct.new(:a) do ... end` and `Class.new do ... end` build a type whose methods a subclass calls by bare
  // name; an unrelated class with the same names is never the answer. Ruby 3.3 runs each call of the subclasses.
  "families.rb": [
    "Shape = Struct.new(:side) do",
    "  def self.describe(name) = name",
    "  def area = 1",
    "end",
    "Mold = Class.new do",
    "  def self.stamp(name) = name",
    "  def fill = 2",
    "end",
    "class Square < Shape",
    "  describe :square",
    "  def perimeter = area",
    "end",
    "class Cast < Mold",
    "  stamp :cast",
    "  def pour = fill",
    "end",
    "class Pebble",
    "  def area = -1",
    "  def fill = -2",
    "  def self.describe(name) = -1",
    "  def self.stamp(name) = -2",
    "  def roll = area",
    "end",
    "",
  ],
  // A subclass calls a method of its base, a base the method its subclass declares, an includer the method of its module;
  // a class the heritage never connects (`Dust`) reaches none, and a class's own method wins over a decoy's.
  "heritage.rb": [
    "class Trunk",
    "  def sap = 1",
    "  def grow = leaf",
    "end",
    "class Branch < Trunk",
    "  def leaf = 2",
    "  def sprout = sap",
    "end",
    "module Water",
    "  def drink = 3",
    "end",
    "class Root",
    "  include Water",
    "  def soak = drink",
    "end",
    "class Rock",
    "  def sap = -1",
    "  def drink = -2",
    "  def erode = sap",
    "end",
    "class Dust",
    "  def settle = sap",
    "end",
    "",
  ],
  // A `def object.name` runs on that object, so only `self` or the enclosing constant makes a class method of it.
  "singletons.rb": [
    "class Valve",
    "  def self.verify = 1",
    "  def Valve.make = verify",
    "  def open_with(door)",
    "    def door.flow",
    "      verify",
    "    end",
    "  end",
    "end",
    "",
  ],
  // A bare method name used as a receiver is a call of that method.
  "chains.rb": [
    "class Ledger",
    "  def entries = [1, 2]",
    "  def notes = [3]",
    "  def sum_entries = entries.sum",
    "  def each_note = notes.each { |n| n }",
    "  def head_entry = entries.map { |e| e }.first",
    "end",
    "class Archive",
    "  def entries = []",
    "  def notes = []",
    "end",
    "",
  ],
  // A module's method is reached from a class that includes it, and a top-level `def` from any class; a class that
  // never names the module raises NameError for the module's method.
  "mixins.rb": [
    "module Stoker",
    "  def stoke = 1",
    "end",
    "def kindle = 2",
    "class Furnace",
    "  def burn = 0",
    "end",
    "",
  ],
  "mixed_use.rb": [
    'require_relative "mixins"',
    "class Boiler < Furnace",
    "  include Stoker",
    "  def fire",
    "    stoke",
    "    kindle",
    "  end",
    "end",
    "class Chimney",
    "  def draw",
    "    stoke",
    "    kindle",
    "  end",
    "end",
    "def outsider",
    "  stoke",
    "  kindle",
    "end",
    "",
  ],
  // A top-level `include` mixes the module into every object, so a top-level `def` of the file reaches its methods; a
  // file that never includes the module raises NameError for them.
  "includer.rb": ['require_relative "mixins"', "include Stoker", "def insider", "  stoke", "end", ""],
  "inclusion.rb": ["module Draft", "  def breeze = 1", "end", "include Draft", "def window", "  breeze", "end", ""],
  "nodraft.rb": ["module Chill", "  def frost = 1", "end", "def pane", "  frost", "end", ""],
  // A block of a receiverless call may run with another `self` unless the file shows the method yielding, or taking a
  // `&block` it does not evaluate. A call on a constant does not depend on `self`, so it is recorded in such a block.
  "dsl.rb": [
    "class Stage",
    "  def beam = 1",
    "  def gel(x) = x",
    "  def around",
    "    yield",
    "  end",
    "  def stage_set",
    "    mock_app do",
    '      get("/") { beam }',
    "    end",
    "  end",
    "  def kept",
    "    around { beam }",
    "  end",
    "  def with_args",
    "    around { gel(1) }",
    "  end",
    "  def blind",
    "    mock_app { gel(2) }",
    "  end",
    "  def wrap(&block)",
    "    block.call",
    "  end",
    "  def forwards(&block)",
    "    wrap(&block)",
    "  end",
    "  def evaluates(&block)",
    "    Gadget.new.instance_eval(&block)",
    "  end",
    "  def closure_block",
    "    wrap { beam }",
    "  end",
    "  def chained_block",
    "    forwards { beam }",
    "  end",
    "  def evaluated_block",
    "    evaluates { beam }",
    "  end",
    "  def qualified_in_dsl",
    "    mock_app do",
    "      Gadget.make",
    "      Gadget.new",
    "      beam",
    "      self.beam",
    "    end",
    "  end",
    "end",
    "class Gadget",
    "  def self.make = 1",
    "end",
    "",
  ],
  // The parser takes `c0&mask`, `c0 -c1`, and `c0 [1]` for calls of `c0`; Ruby reads the local when one is bound.
  "locals_ops.rb": [
    "def mask_bits(b)",
    "  c0 = b[0]",
    "  c1 = b[1]",
    "  u = (c0&0x3f)<<6 | (c1&0x3f)",
    "  v = c0 -c1",
    "  w = c0 [1]",
    "  [u, v, w]",
    "end",
    "",
  ],
};

export const RUBY_SCOPE_SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RUBY_SCOPE_LINES).map(([name, lines]) => [name, lines.join("\n")]),
);

/** A file, a 1-based line, a token on it, and which occurrence of the token (default the first). */
export type RubyScopeSite = readonly [file: string, line: number, token: string, occurrence?: number];

/** 1-based source position of a token; a generated method is declared at its argument (`:v`). */
export function rubyScopeSite(
  paths: Readonly<Record<string, string>>,
  [file, line, token, occurrence = 0]: RubyScopeSite,
): { file: string; line: number; column: number } {
  const text = RUBY_SCOPE_LINES[file]?.[line - 1];
  const absolute = paths[file];
  if (text === undefined || !absolute) throw new Error(`Missing Ruby scope fixture site ${file}:${line}`);
  let from = 0;
  for (let seen = 0; seen <= occurrence; seen += 1) {
    const at = text.indexOf(token, from);
    if (at < 0) throw new Error(`Missing Ruby scope fixture token ${token} at ${file}:${line}`);
    if (seen === occurrence) return { file: absolute, line, column: at + 1 };
    from = at + token.length;
  }
  throw new Error(`Missing Ruby scope fixture occurrence ${token} at ${file}:${line}`);
}

type Target = readonly [file: string, line: number, name: string];

/** Use site, then the declaration it must reach, or null when no declaration is proven. */
export const RUBY_SCOPE_GOTO: ReadonlyArray<readonly [use: RubyScopeSite, target: Target | null]> = [
  // Two classes with a reader of the same name, and a class without one.
  [
    ["scope.rb", 3, "v"],
    ["scope.rb", 2, "v"],
  ],
  [
    ["scope.rb", 7, "v"],
    ["scope.rb", 6, "v"],
  ],
  [["scope.rb", 10, "v", 0], null],
  [["scope.rb", 10, "v", 1], null],
  // Only an instance method of the owner reaches its reader.
  [
    ["scope.rb", 14, "w", 1],
    ["scope.rb", 13, "w"],
  ],
  [["scope.rb", 15, "w"], null],
  [["scope.rb", 17, "w"], null],
  [["scope.rb", 20, "w"], null],
  [["scope.rb", 24, "w"], null],
  [
    ["scope.rb", 27, "later"],
    ["scope.rb", 28, "later"],
  ],
  // A parameter, a block parameter, or a local hides the reader; a multiple, compound, or rescue assignment declares one.
  [
    ["locals.rb", 4, "name", 0],
    ["locals.rb", 2, "name="],
  ],
  [
    ["locals.rb", 4, "name", 1],
    ["locals.rb", 3, "name"],
  ],
  [
    ["locals.rb", 5, "name"],
    ["locals.rb", 3, "name"],
  ],
  [["locals.rb", 8, "name"], null],
  [["locals.rb", 9, "name"], null],
  [["locals.rb", 12, "count"], null],
  [["locals.rb", 13, "count"], null],
  [["locals.rb", 16, "err"], null],
  [["locals.rb", 17, "err"], null],
  [["locals.rb", 30, "item"], null],
  [["locals.rb", 31, "item"], null],
  [
    ["locals.rb", 20, "name", 1],
    ["locals.rb", 20, "name"],
  ],
  [
    ["locals.rb", 24, "name"],
    ["locals.rb", 23, "name"],
  ],
  [
    ["locals.rb", 27, "name"],
    ["locals.rb", 2, "name"],
  ],
  // The later of a `def` and an `attr_*` of one name wins, for bare names and receivers alike.
  [
    ["order.rb", 4, "ay", 0],
    ["order.rb", 3, "ay"],
  ],
  [
    ["order.rb", 4, "ay", 1],
    ["order.rb", 3, "ay"],
  ],
  [
    ["order.rb", 7, "dy"],
    ["order.rb", 7, "dy"],
  ],
  [
    ["order.rb", 9, "dy", 0],
    ["order.rb", 8, "dy"],
  ],
  [
    ["order.rb", 9, "dy", 1],
    ["order.rb", 8, "dy"],
  ],
  [
    ["order.rb", 14, "z", 0],
    ["order.rb", 13, "z="],
  ],
  [
    ["order.rb", 14, "z", 1],
    ["order.rb", 12, "z"],
  ],
  [
    ["order.rb", 19, "ay"],
    ["order.rb", 3, "ay"],
  ],
  [
    ["order.rb", 21, "dy"],
    ["order.rb", 8, "dy"],
  ],
  // A receiver the index cannot type names nothing, for a generated method and a `def` alike.
  [["receivers.rb", 3, "shut", 0], null],
  [["receivers.rb", 3, "shut", 1], null],
  [["receivers.rb", 8, "lock", 0], null],
  [["receivers.rb", 12, "seal", 1], null],
  [["receivers.rb", 17, "latch", 0], null],
  // Typed locals, a constructed receiver, and a multiple assignment reach their own class, never the decoy.
  [
    ["operator.rb", 6, "mode"],
    ["device.rb", 2, "mode="],
  ],
  [
    ["operator.rb", 7, "mode"],
    ["device.rb", 2, "mode"],
  ],
  [
    ["operator.rb", 8, "mode"],
    ["device.rb", 2, "mode="],
  ],
  [
    ["operator.rb", 9, "target"],
    ["device.rb", 3, "target="],
  ],
  [
    ["operator.rb", 10, "label"],
    ["device.rb", 4, "label="],
  ],
  [
    ["operator.rb", 11, "full?"],
    ["device.rb", 5, "full?"],
  ],
  [
    ["operator.rb", 12, "drain!"],
    ["device.rb", 6, "drain!"],
  ],
  [
    ["operator.rb", 13, "mode"],
    ["device.rb", 2, "mode="],
  ],
  [
    ["operator.rb", 13, "label"],
    ["device.rb", 4, "label="],
  ],
  [
    ["operator.rb", 15, "mode"],
    ["decoy.rb", 2, "mode="],
  ],
  [
    ["operator.rb", 16, "full?"],
    ["decoy.rb", 5, "full?"],
  ],
  [
    ["operator.rb", 17, "drain!"],
    ["decoy.rb", 6, "drain!"],
  ],
  // A parameter list, a pattern, or an assignment target binds the name wherever it is written: a lambda literal, a
  // `case ... in`, `value => pattern`, `value in pattern`, a named capture. The first `k` of `return k if s in { k: }`
  // precedes the pattern and still calls the reader.
  [["shadow.rb", 4, "k", 0], null],
  [["shadow.rb", 4, "k", 1], null],
  [["shadow.rb", 7, "k", 0], null],
  [["shadow.rb", 7, "k", 1], null],
  [["shadow.rb", 10, "k", 0], null],
  [["shadow.rb", 10, "k", 1], null],
  [["shadow.rb", 13, "k", 0], null],
  [["shadow.rb", 13, "k", 1], null],
  [["shadow.rb", 17, "k"], null],
  [["shadow.rb", 18, "k"], null],
  [["shadow.rb", 23, "k"], null],
  [["shadow.rb", 24, "k"], null],
  [["shadow.rb", 28, "k"], null],
  [["shadow.rb", 29, "k"], null],
  [["shadow.rb", 32, "k"], null],
  [["shadow.rb", 33, "k"], null],
  [["shadow.rb", 37, "k", 0], null],
  [["shadow.rb", 37, "k", 1], null],
  [["shadow.rb", 38, "k"], null],
  [["shadow.rb", 43, "k"], null],
  [["shadow.rb", 44, "k"], null],
  [["shadow.rb", 49, "k"], null],
  [["shadow.rb", 50, "k"], null],
  [
    ["shadow.rb", 54, "k", 0],
    ["shadow.rb", 2, "k"],
  ],
  [["shadow.rb", 54, "k", 1], null],
  [["shadow.rb", 55, "k"], null],
  [["shadow.rb", 59, "k"], null],
  // Names that only appear as a property, a hash key, or a keyword argument bind nothing, so the bare read still calls the reader.
  [["shadow.rb", 65, "k"], null],
  [
    ["shadow.rb", 66, "k"],
    ["shadow.rb", 2, "k="],
  ],
  [
    ["shadow.rb", 69, "k"],
    ["shadow.rb", 2, "k"],
  ],
  // `self` is an instance only inside an instance method: a singleton method, a `class << self` body, a class body, and
  // a `def` inside a block (`Struct.new do ... end`) see the class.
  [
    ["selfs.rb", 4, "lv"],
    ["selfs.rb", 2, "lv"],
  ],
  [
    ["selfs.rb", 5, "lv"],
    ["selfs.rb", 2, "lv="],
  ],
  [["selfs.rb", 8, "lv"], null],
  [["selfs.rb", 9, "lv"], null],
  [["selfs.rb", 13, "lv"], null],
  [["selfs.rb", 17, "lv"], null],
  [["selfs.rb", 22, "lv"], null],
  [["selfs.rb", 23, "lv"], null],
  [
    ["selfs.rb", 29, "lv"],
    ["selfs.rb", 2, "lv"],
  ],
  [["selfs.rb", 32, "lv"], null],
  [
    ["selfs.rb", 38, "ev"],
    ["selfs.rb", 36, "ev"],
  ],
  [
    ["selfs.rb", 39, "ev"],
    ["selfs.rb", 36, "ev="],
  ],
  [
    ["selfs.rb", 45, "mv"],
    ["selfs.rb", 43, "mv"],
  ],
  [
    ["selfs.rb", 46, "mv"],
    ["selfs.rb", 43, "mv="],
  ],
  [["selfs.rb", 50, "mv"], null],
  [["selfs.rb", 51, "mv"], null],
  // What a block or a lambda binds ends with it: inside, the parameter or write is the local; after, the reader.
  [
    ["blocks.rb", 5, "name", 1],
    ["blocks.rb", 5, "name"],
  ],
  [
    ["blocks.rb", 6, "name"],
    ["blocks.rb", 3, "name"],
  ],
  [
    ["blocks.rb", 10, "total"],
    ["blocks.rb", 3, "total"],
  ],
  [
    ["blocks.rb", 13, "limit"],
    ["blocks.rb", 2, "limit"],
  ],
  [["blocks.rb", 13, "item", 1], null],
  [
    ["blocks.rb", 14, "limit"],
    ["blocks.rb", 2, "limit"],
  ],
  [
    ["blocks.rb", 18, "name"],
    ["blocks.rb", 17, "name"],
  ],
  [
    ["blocks.rb", 20, "name"],
    ["blocks.rb", 3, "name"],
  ],
  [
    ["blocks.rb", 23, "limit", 1],
    ["blocks.rb", 23, "limit"],
  ],
  [
    ["blocks.rb", 24, "limit"],
    ["blocks.rb", 2, "limit"],
  ],
  [
    ["blocks.rb", 28, "limit"],
    ["blocks.rb", 2, "limit"],
  ],
  [
    ["blocks.rb", 29, "limit"],
    ["blocks.rb", 2, "limit="],
  ],
  [
    ["blocks.rb", 34, "name"],
    ["blocks.rb", 3, "name"],
  ],
  [
    ["blocks.rb", 35, "name"],
    ["blocks.rb", 3, "name"],
  ],
  [["blocks.rb", 40, "limit"], null],
  [["blocks.rb", 41, "limit"], null],
  [["blocks.rb", 46, "limit"], null],
  [["blocks.rb", 51, "limit"], null],
  // A generated method is an instance method: no constant receiver reaches it, in the file or from another file, and a
  // singleton `def` of the same name stays the answer for a constant and for `self` in a singleton method.
  [["statics.rb", 32, "ax"], null],
  [["statics.rb", 33, "ax"], null],
  [["use_statics.rb", 4, "ax"], null],
  [["use_statics.rb", 5, "ax"], null],
  [["statics.rb", 25, "kind"], null],
  [["statics.rb", 26, "kind"], null],
  [["use_statics.rb", 8, "kind"], null],
  [
    ["statics.rb", 27, "kind"],
    ["statics.rb", 20, "kind"],
  ],
  [
    ["statics.rb", 14, "level"],
    ["statics.rb", 7, "level"],
  ],
  [
    ["statics.rb", 15, "level"],
    ["statics.rb", 7, "level"],
  ],
  [
    ["statics.rb", 16, "name"],
    ["statics.rb", 10, "name"],
  ],
  [
    ["statics.rb", 34, "level"],
    ["statics.rb", 7, "level"],
  ],
  [
    ["statics.rb", 35, "name"],
    ["statics.rb", 10, "name"],
  ],
  [
    ["use_statics.rb", 6, "level"],
    ["statics.rb", 7, "level"],
  ],
  [
    ["use_statics.rb", 7, "name"],
    ["statics.rb", 10, "name"],
  ],
  // A visibility call around an attr macro defines the same members. A macro the index cannot read defines nothing.
  [
    ["wrapped.rb", 7, "reserve"],
    ["wrapped.rb", 2, "reserve"],
  ],
  [
    ["wrapped.rb", 7, "cap"],
    ["wrapped.rb", 3, "cap"],
  ],
  [["wrapped.rb", 7, "slot"], null],
  [
    ["wrapped.rb", 8, "note"],
    ["wrapped.rb", 4, "note="],
  ],
  // A call nested in an argument, a receiver chain, or a block is a call of the same method; a block parameter hides it.
  [
    ["nested.rb", 6, "reading"],
    ["nested.rb", 2, "reading"],
  ],
  [
    ["nested.rb", 7, "reading"],
    ["nested.rb", 2, "reading"],
  ],
  [
    ["nested.rb", 8, "pulse"],
    ["nested.rb", 3, "pulse"],
  ],
  [
    ["nested.rb", 9, "pulse"],
    ["nested.rb", 3, "pulse"],
  ],
  [
    ["nested.rb", 10, "pulse"],
    ["nested.rb", 3, "pulse"],
  ],
  [
    ["nested.rb", 11, "reading"],
    ["nested.rb", 2, "reading"],
  ],
  [
    ["nested.rb", 14, "reading", 1],
    ["nested.rb", 14, "reading"],
  ],
  // A top-level local is no local inside a def, and the locals of a class or module body end with it.
  [["gates.rb", 3, "top_total"], null],
  [
    ["gates.rb", 10, "cx"],
    ["gates.rb", 9, "cx"],
  ],
  [["gates.rb", 13, "cx"], null],
  [["gates.rb", 19, "mx"], null],
  [
    ["gates.rb", 21, "top_total"],
    ["gates.rb", 1, "top_total"],
  ],
  [
    ["gates.rb", 22, "top_total"],
    ["gates.rb", 1, "top_total"],
  ],
  // A type a block builds owns its methods for a subclass, and a decoy class of the same names is never the answer.
  [
    ["families.rb", 10, "describe"],
    ["families.rb", 2, "describe"],
  ],
  [
    ["families.rb", 11, "area"],
    ["families.rb", 3, "area"],
  ],
  [
    ["families.rb", 14, "stamp"],
    ["families.rb", 6, "stamp"],
  ],
  [
    ["families.rb", 15, "fill"],
    ["families.rb", 7, "fill"],
  ],
  [
    ["families.rb", 22, "area"],
    ["families.rb", 18, "area"],
  ],
  [
    ["singletons.rb", 3, "verify"],
    ["singletons.rb", 2, "verify"],
  ],
  [
    ["chains.rb", 4, "entries", 1],
    ["chains.rb", 2, "entries"],
  ],
  [
    ["chains.rb", 5, "notes"],
    ["chains.rb", 3, "notes"],
  ],
  [
    ["chains.rb", 6, "entries"],
    ["chains.rb", 2, "entries"],
  ],
  [
    ["mixed_use.rb", 5, "stoke"],
    ["mixins.rb", 2, "stoke"],
  ],
  [
    ["mixed_use.rb", 6, "kindle"],
    ["mixins.rb", 4, "kindle"],
  ],
  [
    ["mixed_use.rb", 12, "kindle"],
    ["mixins.rb", 4, "kindle"],
  ],
  [
    ["dsl.rb", 13, "beam"],
    ["dsl.rb", 2, "beam"],
  ],
  [
    ["dsl.rb", 31, "beam"],
    ["dsl.rb", 2, "beam"],
  ],
  [
    ["dsl.rb", 41, "make"],
    ["dsl.rb", 49, "make"],
  ],
  [
    ["includer.rb", 4, "stoke"],
    ["mixins.rb", 2, "stoke"],
  ],
  // Heritage links a base, its subclass, and a module with its includer; nothing links `Dust`.
  [
    ["heritage.rb", 3, "leaf"],
    ["heritage.rb", 6, "leaf"],
  ],
  [
    ["heritage.rb", 7, "sap"],
    ["heritage.rb", 2, "sap"],
  ],
  [
    ["heritage.rb", 14, "drink"],
    ["heritage.rb", 10, "drink"],
  ],
  [
    ["heritage.rb", 19, "sap"],
    ["heritage.rb", 17, "sap"],
  ],
  [["heritage.rb", 22, "sap"], null],
  // The locals of an operator the parser took for a call.
  [
    ["locals_ops.rb", 4, "c0"],
    ["locals_ops.rb", 2, "c0"],
  ],
  [
    ["locals_ops.rb", 4, "c1"],
    ["locals_ops.rb", 3, "c1"],
  ],
  [
    ["locals_ops.rb", 5, "c0"],
    ["locals_ops.rb", 2, "c0"],
  ],
  [
    ["locals_ops.rb", 5, "c1"],
    ["locals_ops.rb", 3, "c1"],
  ],
  [
    ["locals_ops.rb", 6, "c0"],
    ["locals_ops.rb", 2, "c0"],
  ],
];

type Coverage = "complete" | "partial";

/** Declaration, then every site `findReferences` lists for it and its coverage state. */
export const RUBY_SCOPE_REFERENCES: ReadonlyArray<
  readonly [declaration: RubyScopeSite, sites: readonly RubyScopeSite[], coverage: Coverage]
> = [
  [
    ["scope.rb", 2, ":v"],
    [
      ["scope.rb", 2, ":v"],
      ["scope.rb", 3, "v"],
    ],
    "complete",
  ],
  [
    ["scope.rb", 6, ":v"],
    [
      ["scope.rb", 6, ":v"],
      ["scope.rb", 7, "v"],
    ],
    "complete",
  ],
  [
    ["scope.rb", 13, ":w"],
    [
      ["scope.rb", 13, ":w"],
      ["scope.rb", 14, "w", 1],
    ],
    "complete",
  ],
  [
    ["scope.rb", 28, ":later"],
    [
      ["scope.rb", 27, "later"],
      ["scope.rb", 28, ":later"],
    ],
    "complete",
  ],
  // The reader's sites exclude the parameter, block parameter, and locals; the writer site `self.name =` is listed.
  [
    ["locals.rb", 2, ":name"],
    [
      ["locals.rb", 2, ":name"],
      ["locals.rb", 4, "name", 0],
      ["locals.rb", 27, "name"],
    ],
    "complete",
  ],
  [["locals.rb", 2, ":count"], [["locals.rb", 2, ":count"]], "complete"],
  [["locals.rb", 2, ":err"], [["locals.rb", 2, ":err"]], "complete"],
  [["locals.rb", 2, ":item"], [["locals.rb", 2, ":item"]], "complete"],
  [
    ["order.rb", 3, "ay"],
    [
      ["order.rb", 3, "ay"],
      ["order.rb", 4, "ay", 0],
      ["order.rb", 4, "ay", 1],
      ["order.rb", 19, "ay"],
    ],
    "complete",
  ],
  [["order.rb", 7, "dy"], [["order.rb", 7, "dy"]], "complete"],
  [
    ["order.rb", 8, ":dy"],
    [
      ["order.rb", 8, ":dy"],
      ["order.rb", 9, "dy", 0],
      ["order.rb", 9, "dy", 1],
      ["order.rb", 21, "dy"],
    ],
    "complete",
  ],
  [
    ["order.rb", 12, ":z"],
    [
      ["order.rb", 12, ":z"],
      ["order.rb", 14, "z", 1],
    ],
    "complete",
  ],
  [
    ["order.rb", 13, "z"],
    [
      ["order.rb", 13, "z"],
      ["order.rb", 14, "z", 0],
    ],
    "complete",
  ],
  // Receiver sites are not listed; a generated method reports the coverage a `def` of the same shape does.
  [["receivers.rb", 2, ":shut"], [["receivers.rb", 2, ":shut"]], "complete"],
  [["receivers.rb", 6, "lock"], [["receivers.rb", 6, "lock"]], "complete"],
  [["receivers.rb", 7, "lock"], [["receivers.rb", 7, "lock"]], "complete"],
  [["receivers.rb", 11, ":seal"], [["receivers.rb", 11, ":seal"]], "partial"],
  [["receivers.rb", 15, "latch"], [["receivers.rb", 15, "latch"]], "partial"],
  [["receivers.rb", 16, "latch"], [["receivers.rb", 16, "latch"]], "partial"],
  [
    ["device.rb", 2, ":mode"],
    [
      ["device.rb", 2, ":mode"],
      ["operator.rb", 6, "mode"],
      ["operator.rb", 7, "mode"],
      ["operator.rb", 8, "mode"],
      ["operator.rb", 13, "mode"],
    ],
    "complete",
  ],
  [
    ["device.rb", 3, ":target"],
    [
      ["device.rb", 3, ":target"],
      ["operator.rb", 9, "target"],
    ],
    "complete",
  ],
  [
    ["device.rb", 4, "label"],
    [
      ["device.rb", 4, "label"],
      ["operator.rb", 10, "label"],
      ["operator.rb", 13, "label"],
    ],
    "complete",
  ],
  [
    ["device.rb", 5, "full?"],
    [
      ["device.rb", 5, "full?"],
      ["operator.rb", 11, "full?"],
    ],
    "complete",
  ],
  [
    ["device.rb", 6, "drain!"],
    [
      ["device.rb", 6, "drain!"],
      ["operator.rb", 12, "drain!"],
    ],
    "complete",
  ],
  [
    ["decoy.rb", 2, ":mode"],
    [
      ["decoy.rb", 2, ":mode"],
      ["operator.rb", 15, "mode"],
    ],
    "complete",
  ],
  [
    ["decoy.rb", 5, "full?"],
    [
      ["decoy.rb", 5, "full?"],
      ["operator.rb", 16, "full?"],
    ],
    "complete",
  ],
  [
    ["decoy.rb", 6, "drain!"],
    [
      ["decoy.rb", 6, "drain!"],
      ["operator.rb", 17, "drain!"],
    ],
    "complete",
  ],
  [
    ["shadow.rb", 2, ":k"],
    [
      ["shadow.rb", 2, ":k"],
      ["shadow.rb", 54, "k", 0],
      ["shadow.rb", 66, "k"],
      ["shadow.rb", 69, "k"],
    ],
    "partial",
  ],
  [
    ["selfs.rb", 2, ":lv"],
    [
      ["selfs.rb", 2, ":lv"],
      ["selfs.rb", 4, "lv"],
      ["selfs.rb", 5, "lv"],
      ["selfs.rb", 29, "lv"],
    ],
    "partial",
  ],
  [
    ["selfs.rb", 36, ":ev"],
    [
      ["selfs.rb", 36, ":ev"],
      ["selfs.rb", 38, "ev"],
      ["selfs.rb", 39, "ev"],
    ],
    "complete",
  ],
  [
    ["selfs.rb", 43, ":mv"],
    [
      ["selfs.rb", 43, ":mv"],
      ["selfs.rb", 45, "mv"],
      ["selfs.rb", 46, "mv"],
    ],
    "partial",
  ],
  [
    ["blocks.rb", 2, ":limit"],
    [
      ["blocks.rb", 2, ":limit"],
      ["blocks.rb", 13, "limit"],
      ["blocks.rb", 14, "limit"],
      ["blocks.rb", 24, "limit"],
      ["blocks.rb", 28, "limit"],
      ["blocks.rb", 29, "limit"],
    ],
    "partial",
  ],
  [
    ["blocks.rb", 3, ":name"],
    [
      ["blocks.rb", 3, ":name"],
      ["blocks.rb", 6, "name"],
      ["blocks.rb", 20, "name"],
      ["blocks.rb", 34, "name"],
      ["blocks.rb", 35, "name"],
    ],
    "complete",
  ],
  [
    ["blocks.rb", 3, ":total"],
    [
      ["blocks.rb", 3, ":total"],
      ["blocks.rb", 10, "total"],
    ],
    "complete",
  ],
  [["blocks.rb", 3, ":item"], [["blocks.rb", 3, ":item"]], "complete"],
  [
    ["statics.rb", 7, "level"],
    [
      ["statics.rb", 7, "level"],
      ["statics.rb", 14, "level"],
      ["statics.rb", 15, "level"],
      ["statics.rb", 34, "level"],
      ["use_statics.rb", 6, "level"],
    ],
    "complete",
  ],
  [
    ["statics.rb", 10, "name"],
    [
      ["statics.rb", 10, "name"],
      ["statics.rb", 16, "name"],
      ["statics.rb", 35, "name"],
      ["use_statics.rb", 7, "name"],
    ],
    "complete",
  ],
  [["statics.rb", 5, ":level"], [["statics.rb", 5, ":level"]], "complete"],
  [["statics.rb", 6, ":name"], [["statics.rb", 6, ":name"]], "complete"],
  [["statics.rb", 2, ":ax"], [["statics.rb", 2, ":ax"]], "complete"],
  [
    ["statics.rb", 20, ":kind"],
    [
      ["statics.rb", 20, ":kind"],
      ["statics.rb", 27, "kind"],
    ],
    "partial",
  ],
  [
    ["wrapped.rb", 2, ":reserve"],
    [
      ["wrapped.rb", 2, ":reserve"],
      ["wrapped.rb", 7, "reserve"],
    ],
    "complete",
  ],
  [
    ["wrapped.rb", 3, ":cap"],
    [
      ["wrapped.rb", 3, ":cap"],
      ["wrapped.rb", 7, "cap"],
    ],
    "complete",
  ],
  [
    ["wrapped.rb", 4, ":note"],
    [
      ["wrapped.rb", 4, ":note"],
      ["wrapped.rb", 8, "note"],
    ],
    "complete",
  ],
  [["wrapped.rb", 11, "reserve"], [["wrapped.rb", 11, "reserve"]], "complete"],
  [["wrapped.rb", 12, "cap"], [["wrapped.rb", 12, "cap"]], "complete"],
  [["wrapped.rb", 13, "slot"], [["wrapped.rb", 13, "slot"]], "complete"],
  [
    ["nested.rb", 2, "reading"],
    [
      ["nested.rb", 2, "reading"],
      ["nested.rb", 6, "reading"],
      ["nested.rb", 7, "reading"],
      ["nested.rb", 11, "reading"],
    ],
    "complete",
  ],
  [
    ["nested.rb", 3, "pulse"],
    [
      ["nested.rb", 3, "pulse"],
      ["nested.rb", 8, "pulse"],
      ["nested.rb", 9, "pulse"],
      ["nested.rb", 10, "pulse"],
    ],
    "complete",
  ],
  [["nested.rb", 19, "reading"], [["nested.rb", 19, "reading"]], "complete"],
  [["nested.rb", 20, "pulse"], [["nested.rb", 20, "pulse"]], "complete"],
  [
    ["gates.rb", 9, "cx"],
    [
      ["gates.rb", 9, "cx"],
      ["gates.rb", 10, "cx"],
    ],
    "complete",
  ],
  [
    ["families.rb", 3, "area"],
    [
      ["families.rb", 3, "area"],
      ["families.rb", 11, "area"],
    ],
    "complete",
  ],
  [
    ["families.rb", 7, "fill"],
    [
      ["families.rb", 7, "fill"],
      ["families.rb", 15, "fill"],
    ],
    "complete",
  ],
  [
    ["families.rb", 18, "area"],
    [
      ["families.rb", 18, "area"],
      ["families.rb", 22, "area"],
    ],
    "complete",
  ],
  [
    ["heritage.rb", 2, "sap"],
    [
      ["heritage.rb", 2, "sap"],
      ["heritage.rb", 7, "sap"],
    ],
    "complete",
  ],
  [
    ["heritage.rb", 6, "leaf"],
    [
      ["heritage.rb", 3, "leaf"],
      ["heritage.rb", 6, "leaf"],
    ],
    "complete",
  ],
  [
    ["heritage.rb", 10, "drink"],
    [
      ["heritage.rb", 10, "drink"],
      ["heritage.rb", 14, "drink"],
    ],
    "complete",
  ],
  [
    ["heritage.rb", 17, "sap"],
    [
      ["heritage.rb", 17, "sap"],
      ["heritage.rb", 19, "sap"],
    ],
    "complete",
  ],
  [["heritage.rb", 18, "drink"], [["heritage.rb", 18, "drink"]], "complete"],
  [["families.rb", 19, "fill"], [["families.rb", 19, "fill"]], "complete"],
  [["families.rb", 20, "describe"], [["families.rb", 20, "describe"]], "complete"],
  [["families.rb", 21, "stamp"], [["families.rb", 21, "stamp"]], "complete"],
  [
    ["chains.rb", 2, "entries"],
    [
      ["chains.rb", 2, "entries"],
      ["chains.rb", 4, "entries", 1],
      ["chains.rb", 6, "entries"],
    ],
    "complete",
  ],
  [
    ["chains.rb", 3, "notes"],
    [
      ["chains.rb", 3, "notes"],
      ["chains.rb", 5, "notes"],
    ],
    "complete",
  ],
  [["chains.rb", 9, "entries"], [["chains.rb", 9, "entries"]], "complete"],
  [["chains.rb", 10, "notes"], [["chains.rb", 10, "notes"]], "complete"],
];

/**
 * The methods each caller reaches through `calls` edges, one entry per call site. A bare name that is no local calls
 * the method it names, wherever it stands: a statement, an argument, a block, a default value.
 */
export const RUBY_SCOPE_CALLS: ReadonlyArray<readonly [file: string, caller: string, callees: readonly string[]]> = [
  ["locals.rb", "initialize", ["locals.rb:name="]],
  ["locals.rb", "reader", ["locals.rb:name"]],
  ["locals.rb", "multi", []],
  ["locals.rb", "block_param", []],
  ["locals.rb", "plain_local", []],
  ["order.rb", "go", ["order.rb:ay", "order.rb:ay"]],
  ["order.rb", "check", ["order.rb:dy", "order.rb:dy"]],
  ["order.rb", "probe", ["order.rb:ay", "order.rb:dy"]],
  ["order.rb", "tick", ["order.rb:z", "order.rb:z="]],
  ["scope.rb", "own", ["scope.rb:w"]],
  ["scope.rb", "early", ["scope.rb:later"]],
  ["scope.rb", "build", []],
  ["scope.rb", "meta", []],
  ["scope.rb", "inside", []],
  [
    "operator.rb",
    "run",
    [
      "decoy.rb:drain!",
      "decoy.rb:full?",
      "decoy.rb:mode=",
      "device.rb:drain!",
      "device.rb:full?",
      "device.rb:label=",
      "device.rb:label=",
      "device.rb:mode",
      "device.rb:mode=",
      "device.rb:mode=",
      "device.rb:mode=",
      "device.rb:target=",
    ],
  ],
  ["selfs.rb", "touch", ["selfs.rb:ev", "selfs.rb:ev="]],
  // Where `self` is an instance, `self.mv` calls the accessor; in a `class << self` body it is the class and calls none.
  ["selfs.rb", "inst2", ["selfs.rb:mv", "selfs.rb:mv="]],
  ["selfs.rb", "meta2", []],
  // A block closes over its method's `self`; what a block binds ends with it, and a parameter hides the reader inside.
  ["blocks.rb", "b1", ["blocks.rb:name"]],
  ["blocks.rb", "b2", ["blocks.rb:total"]],
  ["blocks.rb", "b3", ["blocks.rb:limit", "blocks.rb:limit"]],
  ["blocks.rb", "b4", ["blocks.rb:name"]],
  ["blocks.rb", "b5", ["blocks.rb:limit"]],
  ["blocks.rb", "evaled", ["blocks.rb:limit", "blocks.rb:limit="]],
  ["blocks.rb", "looped_def", ["blocks.rb:name", "blocks.rb:name"]],
  ["blocks.rb", "struct_def", []],
  ["blocks.rb", "class_def", []],
  ["blocks.rb", "inst_eval_def", []],
  ["shadow.rb", "property_only", ["shadow.rb:k", "shadow.rb:k=", "shadow.rb:wrap"]],
  ["shadow.rb", "pattern_test", ["shadow.rb:k"]],
  ["shadow.rb", "lambda_paren", []],
  ["shadow.rb", "named_capture", []],
  // A constant and a `self` that is the class call the singleton method; a constant never calls a generated method.
  ["statics.rb", "build", ["statics.rb:level", "statics.rb:level", "statics.rb:name"]],
  ["statics.rb", "run", ["statics.rb:kind"]],
  ["statics.rb", "m", ["statics.rb:level", "statics.rb:name"]],
  ["use_statics.rb", "m", ["statics.rb:level", "statics.rb:name"]],
  ["wrapped.rb", "report", ["wrapped.rb:cap", "wrapped.rb:reserve"]],
  ["wrapped.rb", "stash", ["wrapped.rb:note="]],
  [
    "nested.rb",
    "run",
    [
      "nested.rb:emit",
      "nested.rb:emit",
      "nested.rb:emit",
      "nested.rb:pulse",
      "nested.rb:pulse",
      "nested.rb:pulse",
      "nested.rb:reading",
      "nested.rb:reading",
      "nested.rb:reading",
    ],
  ],
  ["nested.rb", "shadowed", []],
  ["gates.rb", "uses_top_total", []],
  ["gates.rb", "read", []],
  // A callee may carry `@line` to name the declaration of a same-named decoy apart.
  ["families.rb", "perimeter", ["families.rb:area@3"]],
  ["families.rb", "pour", ["families.rb:fill@7"]],
  ["families.rb", "roll", ["families.rb:area@18"]],
  ["heritage.rb", "grow", ["heritage.rb:leaf"]],
  ["heritage.rb", "sprout", ["heritage.rb:sap@2"]],
  ["heritage.rb", "soak", ["heritage.rb:drink@10"]],
  ["heritage.rb", "erode", ["heritage.rb:sap@17"]],
  ["heritage.rb", "settle", []],
  ["singletons.rb", "make", ["singletons.rb:verify"]],
  ["singletons.rb", "flow", []],
  ["chains.rb", "sum_entries", ["chains.rb:entries@2"]],
  ["chains.rb", "each_note", ["chains.rb:notes@3"]],
  ["chains.rb", "head_entry", ["chains.rb:entries@2"]],
  ["mixed_use.rb", "fire", ["mixins.rb:stoke", "mixins.rb:kindle"]],
  ["mixed_use.rb", "draw", ["mixins.rb:kindle"]],
  ["dsl.rb", "stage_set", []],
  ["dsl.rb", "kept", ["dsl.rb:around", "dsl.rb:beam"]],
  ["dsl.rb", "with_args", ["dsl.rb:around", "dsl.rb:gel"]],
  ["dsl.rb", "blind", []],
  ["dsl.rb", "wrap", []],
  ["dsl.rb", "forwards", ["dsl.rb:wrap"]],
  ["dsl.rb", "evaluates", []],
  ["dsl.rb", "closure_block", ["dsl.rb:wrap", "dsl.rb:beam"]],
  ["dsl.rb", "chained_block", ["dsl.rb:forwards", "dsl.rb:beam"]],
  ["dsl.rb", "evaluated_block", ["dsl.rb:evaluates"]],
  ["dsl.rb", "qualified_in_dsl", ["dsl.rb:make"]],
  ["mixed_use.rb", "outsider", ["mixins.rb:kindle"]],
  ["includer.rb", "insider", ["mixins.rb:stoke"]],
  ["inclusion.rb", "window", ["inclusion.rb:breeze"]],
  ["nodraft.rb", "pane", []],
  ["locals_ops.rb", "mask_bits", []],
];

const locate = (site: { file: string; line: number; column: number }): string =>
  `${fileIdentityKey(site.file)}:${site.line}:${site.column}`;

export async function expectRubyScopeGoto(
  index: ProjectIndex,
  paths: Readonly<Record<string, string>>,
  phase = "index",
): Promise<void> {
  for (const [use, target] of RUBY_SCOPE_GOTO) {
    const label = `${phase}: ${use.join(" ")}`;
    const result = await goToDefinition(index, rubyScopeSite(paths, use));
    if (!target) {
      expect(result.status, label).toBe("not_found");
      continue;
    }
    expect(result.status, label).toBe("ok");
    if (result.status !== "ok") continue;
    const [file, line, name] = target;
    expect(fileIdentityKey(result.definition.file), label).toBe(fileIdentityKey(paths[file]!));
    expect([result.definition.range.start.line, result.definition.localName], label).toEqual([line, name]);
  }
}

export async function expectRubyScopeReferences(
  index: ProjectIndex,
  paths: Readonly<Record<string, string>>,
  phase = "index",
): Promise<void> {
  for (const [declaration, sites, coverage] of RUBY_SCOPE_REFERENCES) {
    const label = `${phase}: ${declaration.join(" ")}`;
    const result = await findReferences(index, rubyScopeSite(paths, declaration));
    expect(result.status, label).toBe("ok");
    if (result.status !== "ok") continue;
    expect(result.referenceCoverage.state, label).toBe(coverage);
    expect(
      result.references.map((reference) => locate({ file: reference.file, ...reference.range.start })).sort(),
      label,
    ).toEqual(sites.map((site) => locate(rubyScopeSite(paths, site))).sort());
  }
}

export async function expectRubyScopeCalls(
  index: ProjectIndex,
  paths: Readonly<Record<string, string>>,
  phase = "index",
): Promise<void> {
  const graph = await buildSymbolGraphDetailed(index);
  const fixtureNames = Object.entries(paths);
  // A node id ends with the index of its name token in the file, which the fixture source turns into a line.
  const lineOf = (id: string, file: string): number | undefined => {
    const index = Number(id.split("::").at(-1));
    const name = fixtureNames.find(([, absolute]) => fileIdentityKey(absolute) === fileIdentityKey(file))?.[0];
    const source = name ? RUBY_SCOPE_SOURCES[name] : undefined;
    return source === undefined || Number.isNaN(index) ? undefined : source.slice(0, index).split("\n").length;
  };
  const nameOf = (id: string, pinned: ReadonlySet<string>): string => {
    const node = graph.nodes.get(id);
    const key = `${fileIdentityKey(node?.file ?? "")}:${node?.name}`;
    return pinned.has(key) ? `${key}@${lineOf(id, node?.file ?? "")}` : key;
  };
  for (const [file, callerName, callees] of RUBY_SCOPE_CALLS) {
    const callers = [...graph.nodes.values()].filter(
      (node) => node.name === callerName && fileIdentityKey(node.file) === fileIdentityKey(paths[file]!),
    );
    expect(callers.length, `${phase}: ${file} ${callerName}`).toBe(1);
    const caller = callers[0]!;
    const expected = callees.map((callee) => {
      const [calleeFile, name] = callee.split(":");
      return `${fileIdentityKey(paths[calleeFile!]!)}:${name}`;
    });
    // A callee spelled `file:name@line` names one declaration among same-named ones.
    const pinned = new Set(expected.filter((callee) => callee.includes("@")).map((callee) => callee.split("@")[0]!));
    const reached = graph.edges
      .filter((edge) => edge.from === caller.id && edge.label === "calls")
      .map((edge) => nameOf(edge.to, pinned))
      .sort();
    expect(reached, `${phase}: calls of ${callerName} in ${file}`).toEqual(expected.sort());
  }
}
