import type { GeneratedMember, SyntaxNodeLike } from "../languages/types.js";
import type { Range } from "../types.js";

/** What each `attr_*` macro defines for one attribute name. */
const ATTRIBUTE_MACROS: Readonly<Record<string, { reader: boolean; writer: boolean }>> = {
  attr_reader: { reader: true, writer: false },
  attr_writer: { reader: false, writer: true },
  attr_accessor: { reader: true, writer: true },
};

/** `attr_reader` accepts the names that a method can have, not an operator or a `?`, `!`, or `=` name. */
const ATTRIBUTE_NAME = /^[A-Za-z_\u0080-\u{10FFFF}][A-Za-z0-9_\u0080-\u{10FFFF}]*$/u;

const NO_MEMBERS: readonly GeneratedMember[] = [];
const generatedMembersByCall = new WeakMap<SyntaxNodeLike, readonly GeneratedMember[]>();
const generatedDeclarationStartsByCall = new WeakMap<SyntaxNodeLike, ReadonlySet<number>>();

function sameNode(left: SyntaxNodeLike | null | undefined, right: SyntaxNodeLike): boolean {
  return !!left && left.type === right.type && left.startIndex === right.startIndex && left.endIndex === right.endIndex;
}

/** The attribute a symbol (`:name`) or a plain string (`"name"`) argument names, or null for any other argument. */
function attributeName(argument: SyntaxNodeLike): string | null {
  let name: string | null = null;
  if (argument.type === "simple_symbol") {
    name = argument.text.slice(1);
  } else if (argument.type === "string") {
    const content = argument.namedChildren;
    if (content.length === 1 && content[0]!.type === "string_content") name = content[0]!.text;
  }
  return name !== null && ATTRIBUTE_NAME.test(name) ? name : null;
}

/**
 * Whether the class or module body declares `name` with a `def` after `call`. Ruby keeps the later of two definitions
 * of a method, so only a later `def` replaces the generated method; an earlier one is replaced by it.
 */
function redefinedLater(body: SyntaxNodeLike, call: SyntaxNodeLike, name: string): boolean {
  return body.namedChildren.some(
    (child) =>
      child.type === "method" && child.startIndex > call.startIndex && child.childForFieldName("name")?.text === name,
  );
}

/** The calls that take a method name or the result of `attr_*` and set its visibility: `private attr_reader :name`. */
const VISIBILITY_CALLS: ReadonlySet<string> = new Set(["private", "protected", "public"]);

/**
 * The class or module body that `call` is a statement of: directly (`attr_reader :name`), or as the argument of a
 * visibility call that is itself a statement (`private attr_reader :name`, `protected(attr_accessor(:name))`). Any
 * other call around it (`memoize attr_reader :name`, a modifier, a block) gives null by default: definitions are unproven.
 * Coverage can allow an unknown argument wrapper: evaluating its arguments cannot rebind the argument's `self`.
 */
function macroBody(call: SyntaxNodeLike, allowArgumentWrapper = false): SyntaxNodeLike | null {
  let statement = call;
  const list = call.parent;
  if (list?.type === "argument_list") {
    const wrapper = list.parent;
    if (wrapper?.type !== "call") return null;
    const visibility = wrapper.childForFieldName("method");
    const isVisibilityCall =
      !wrapper.childForFieldName("receiver") &&
      visibility?.type === "identifier" &&
      VISIBILITY_CALLS.has(visibility.text);
    if (!isVisibilityCall && !allowArgumentWrapper) return null;
    statement = wrapper;
  }
  const body = statement.parent;
  if (body?.type !== "body_statement") return null;
  const owner = body.parent;
  return owner?.type === "class" || owner?.type === "module" ? body : null;
}

/**
 * The methods `attr_reader`, `attr_writer`, and `attr_accessor` define: `name` for a reader and `name=` for a writer,
 * each at the argument token that names it. Only a receiverless call that is a statement of a class or module body
 * counts, or the argument of a `private`, `protected`, or `public` call that is one, with symbol or plain string
 * arguments; a call under a modifier, a block, or another call is not indexed. A method the same body declares with
 * `def` after the call replaces the generated one in Ruby, so it is not generated; a `def` before the call is replaced
 * by it.
 */
export function rubyGeneratedMembers(call: SyntaxNodeLike): readonly GeneratedMember[] {
  if (call.type !== "call") return NO_MEMBERS;
  const method = call.childForFieldName("method");
  if (method?.type !== "identifier" || call.childForFieldName("receiver")) return NO_MEMBERS;
  const macroName = method.text;
  const macro = Object.hasOwn(ATTRIBUTE_MACROS, macroName) ? ATTRIBUTE_MACROS[macroName] : undefined;
  const argumentList = call.childForFieldName("arguments");
  if (!macro || !argumentList) return NO_MEMBERS;
  const cached = generatedMembersByCall.get(call);
  if (cached) return cached;
  const body = macroBody(call);
  if (!body) return NO_MEMBERS;
  const members: GeneratedMember[] = [];
  for (const argument of argumentList.namedChildren) {
    const name = attributeName(argument);
    if (name === null) continue;
    if (macro.reader && !redefinedLater(body, call, name)) members.push({ name, node: argument, arity: 0 });
    if (macro.writer && !redefinedLater(body, call, `${name}=`)) {
      members.push({ name: `${name}=`, node: argument, arity: 1 });
    }
  }
  const result = members.length ? members : NO_MEMBERS;
  generatedMembersByCall.set(call, result);
  return result;
}

/** Definitions that start their own local variable scope and their own `self`. */
const LOCAL_SCOPE_OWNERS: ReadonlySet<string> = new Set([
  "method",
  "singleton_method",
  "class",
  "module",
  "singleton_class",
]);

/** Calls whose block evaluates a `def` against a new class or another receiver, not the enclosing class/module. */
const NEW_CLASS_BLOCK_FACTORIES: Readonly<Record<string, Readonly<Record<string, true>>>> = {
  new: { Struct: true, Class: true, Module: true, "::Struct": true, "::Class": true, "::Module": true },
  define: { Data: true, "::Data": true },
};
const OTHER_CLASS_EVAL_METHODS: Readonly<Record<string, true>> = {
  class_eval: true,
  module_eval: true,
  class_exec: true,
  module_exec: true,
};

/** Whether `block` is the block of a call that builds a class or module: `Struct.new(:a) do ... end`, `Class.new { }`. */
function isTypeFactoryBlock(block: SyntaxNodeLike): boolean {
  const call = block.parent;
  if (call?.type !== "call") return false;
  const methodName = call.childForFieldName("method")?.text;
  const receiver = call.childForFieldName("receiver");
  const factoryOwners =
    methodName && Object.hasOwn(NEW_CLASS_BLOCK_FACTORIES, methodName)
      ? NEW_CLASS_BLOCK_FACTORIES[methodName]
      : undefined;
  return !!factoryOwners && !!receiver && Object.hasOwn(factoryOwners, receiver.text);
}

function isBlockWithOtherSelf(block: SyntaxNodeLike): boolean {
  const call = block.parent;
  if (call?.type !== "call") return false;
  const methodName = call.childForFieldName("method")?.text;
  if (!methodName) return false;
  if (methodName === "instance_eval" || methodName === "instance_exec") return true;
  const receiver = call.childForFieldName("receiver");
  if (receiver && receiver.type !== "self" && Object.hasOwn(OTHER_CLASS_EVAL_METHODS, methodName)) return true;
  return isTypeFactoryBlock(block);
}

/**
 * Receiverless calls whose block keeps the caller's `self`: it is a closure the call runs, not a body it evaluates, or
 * (`class_eval do ... end` in a class body) it evaluates the block in the very class around it.
 */
const SELF_KEEPING_CALLS: ReadonlySet<string> = new Set([
  "loop",
  "lambda",
  "proc",
  "catch",
  "at_exit",
  "trap",
  "fork",
  "tap",
  "then",
  "yield_self",
  "open",
  "synchronize",
  "mon_synchronize",
  "class_eval",
  "module_eval",
  "class_exec",
  "module_exec",
]);

/** The methods that evaluate the block they are handed with another `self`. */
const EVALUATING_METHODS: ReadonlySet<string> = new Set([
  "instance_eval",
  "instance_exec",
  "class_eval",
  "class_exec",
  "module_eval",
  "module_exec",
  "define_method",
  "define_singleton_method",
]);

/** The constructors that build a type from the block they are handed: `Class.new(&block)`, `Data.define(&block)`. */
const TYPE_BUILDING_METHODS: ReadonlySet<string> = new Set(["new", "define"]);

/** What one method of a file does with the block it is handed. */
type BlockUse = { name: string; yields: boolean; blockParam: string | null; passedTo: Set<string>; evaluates: boolean };

/** The name a `&block` parameter binds, "" for an anonymous `&`, or null where the method takes none. */
function blockParameterName(method: SyntaxNodeLike): string | null {
  const parameters = method.childForFieldName("parameters")?.namedChildren ?? [];
  const parameter = parameters.find((child) => child.type === "block_parameter");
  return parameter ? (parameter.childForFieldName("name")?.text ?? "") : null;
}

/** Records where a call in a method hands the method's own block: to an evaluating method, or to another method. */
function noteBlockPass(use: BlockUse, call: SyntaxNodeLike): void {
  const argument = call.childForFieldName("arguments")?.namedChildren.find((child) => child.type === "block_argument");
  if (!argument || (argument.namedChildren[0]?.text ?? "") !== use.blockParam) return;
  const methodName = call.childForFieldName("method")?.text;
  if (!methodName) return;
  const buildsType = !!call.childForFieldName("receiver") && TYPE_BUILDING_METHODS.has(methodName);
  if (EVALUATING_METHODS.has(methodName) || buildsType) use.evaluates = true;
  else use.passedTo.add(methodName);
}

/** Reads the body of a method that may yield or hand on a block. A nested `def` has its own use. */
function scanBlockUse(node: SyntaxNodeLike, use: BlockUse): void {
  for (const child of node.namedChildren) {
    const type = child.type;
    if (type === "method" || type === "singleton_method") continue;
    if (type === "yield") use.yields = true;
    else if (type === "call" && use.blockParam !== null) noteBlockPass(use, child);
    scanBlockUse(child, use);
  }
}

/** Collects the methods of a file, walking the levels above their bodies and reading only a body that may use a block. */
function collectBlockUses(node: SyntaxNodeLike, uses: BlockUse[]): void {
  for (const child of node.namedChildren) {
    const type = child.type;
    if (type !== "method" && type !== "singleton_method") {
      collectBlockUses(child, uses);
      continue;
    }
    const name = child.childForFieldName("name")?.text;
    if (!name) continue;
    const use: BlockUse = {
      name,
      yields: false,
      blockParam: blockParameterName(child),
      passedTo: new Set(),
      evaluates: false,
    };
    uses.push(use);
    if (use.blockParam !== null || child.text.includes("yield")) scanBlockUse(child, use);
  }
}

/**
 * What the methods a file defines do with the block of their call: `yielding` run it in the caller's `self` (one that
 * yields, or takes a `&block` it does not evaluate), and `evaluating` run it with another `self` (`instance_eval(&block)`,
 * `define_method(name, &block)`, `Class.new(&block)`), directly or by handing it to a method of the file that does.
 */
type BlockMethods = { yielding: ReadonlySet<string>; evaluating: ReadonlySet<string> };
const blockMethodsByProgram = new WeakMap<SyntaxNodeLike, BlockMethods>();

function blockMethodsOf(program: SyntaxNodeLike): BlockMethods {
  const known = blockMethodsByProgram.get(program);
  if (known) return known;
  const uses: BlockUse[] = [];
  collectBlockUses(program, uses);
  const evaluating = new Set(uses.filter((use) => use.evaluates).map((use) => use.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const use of uses) {
      if (evaluating.has(use.name) || ![...use.passedTo].some((target) => evaluating.has(target))) continue;
      evaluating.add(use.name);
      grew = true;
    }
  }
  const yielding = new Set<string>();
  for (const use of uses) {
    if ((use.yields || use.blockParam !== null) && !evaluating.has(use.name)) yielding.add(use.name);
  }
  const methods = { yielding, evaluating };
  blockMethodsByProgram.set(program, methods);
  return methods;
}

/**
 * Whether the block may run with a `self` other than the code around it: a block of a known rebinding call, a block that
 * becomes a method body (`define_method`), or the block of a receiverless call whose method the file does not show to
 * yield and that takes no parameters (`mock_app do ... end`, `get("/") { }`, `describe "x" do`), which may evaluate it
 * elsewhere. A block of a call through a receiver (`items.each { }`), or one with parameters, is taken to yield.
 */
export function rubyBlockMayRebindSelf(block: SyntaxNodeLike, program?: SyntaxNodeLike): boolean {
  if (isBlockWithOtherSelf(block)) return true;
  const call = block.parent;
  if (call?.type !== "call") return false;
  const methodName = call.childForFieldName("method")?.text;
  if (!methodName) return false;
  if (methodName === "define_method" || methodName === "define_singleton_method") return true;
  if (call.childForFieldName("receiver") || SELF_KEEPING_CALLS.has(methodName)) return false;
  // A block with parameters receives what the call yields, so it is the caller's closure (`add_offense(node) do |corrector|`);
  // a block without parameters may be a body the call evaluates elsewhere.
  if (block.childForFieldName("parameters")) return false;
  const root = program ?? programOf(block);
  // A method the file never defines is not shown to yield, so the file need not be read for it.
  const text = root.text;
  if (!text.includes(`def ${methodName}`) && !text.includes(`def self.${methodName}`)) return true;
  return !blockMethodsOf(root).yielding.has(methodName);
}

/** Calls whose block becomes a method or a callable value, which `instance_exec` may later run with another `self`. */
const CALLABLE_BODY_CALLS: ReadonlySet<string> = new Set([
  "define_method",
  "define_singleton_method",
  "lambda",
  "proc",
]);

/**
 * Whether the block surely runs with the `self` around it: the block of a call on a value, or of a receiverless call that
 * only runs it (`loop`, `tap`), whose method the file does not show to evaluate a block with another `self`
 * (`items.each { }`, `self.each { }`). The block of a call on a constant (`Builder.build do ... end`), of a method of the
 * file that evaluates its block (`builder.configure do ... end` with `def configure(&block) = instance_eval(&block)`, or
 * a `def self.tap` that does the same), or of any other receiverless call may be a body evaluated elsewhere, even where
 * the file shows the method to take a block (Sinatra's `error NotFound do ... end` runs as an instance method of the
 * application).
 */
function blockSurelyKeepsSelf(block: SyntaxNodeLike): boolean {
  if (isBlockWithOtherSelf(block)) return false;
  const call = block.parent;
  if (call?.type !== "call") return false;
  const methodName = call.childForFieldName("method")?.text;
  if (!methodName || CALLABLE_BODY_CALLS.has(methodName)) return false;
  const receiver = call.childForFieldName("receiver");
  if (receiver) {
    if (receiver.type === "constant" || receiver.type === "scope_resolution") return false;
  } else if (!SELF_KEEPING_CALLS.has(methodName)) {
    return false;
  }
  return !blockMethodsOf(programOf(block)).evaluating.has(methodName);
}

/**
 * Whether the call depends on the `self` around it: a call with no receiver, one on `self`, or a `new` on a receiver that
 * is no constant (`klass.new`). A call on a constant, a local, or another call names the same method wherever `self` is.
 */
export function rubyCallDependsOnSelf(call: SyntaxNodeLike): boolean {
  const receiver = call.childForFieldName("receiver");
  if (!receiver || receiver.type === "self") return true;
  if (call.childForFieldName("method")?.text !== "new") return false;
  return receiver.type !== "constant" && receiver.type !== "scope_resolution";
}

/**
 * The instance method whose body holds `use`, with the class or module that owns it, or null where `self` is not an
 * instance of one: a singleton method, a `class << self` body, a class body, and a `def` inside `Struct.new`,
 * `Class.new`, `instance_eval`, or another class's `class_eval` belong to another `self`. A `def` in an ordinary
 * block (`class_eval`, `.each`) and a block inside a method belong to the enclosing class.
 */
function enclosingInstanceMethod(use: SyntaxNodeLike): { method: SyntaxNodeLike; owner: SyntaxNodeLike } | null {
  let method: SyntaxNodeLike | null = null;
  for (let current = use.parent; current; current = current.parent) {
    const type = current.type;
    if (type === "singleton_method" || type === "singleton_class") return null;
    if (type === "method") {
      method ??= current;
    } else if (type === "block" || type === "do_block") {
      if (method && isBlockWithOtherSelf(current)) return null;
    } else if (type === "class" || type === "module") {
      return method ? { method, owner: current } : null;
    }
  }
  return null;
}

/** Parameter lists: their direct identifiers are plain parameters, and block-local names after a `;`. */
const PARAMETER_LISTS: ReadonlySet<string> = new Set(["method_parameters", "lambda_parameters", "block_parameters"]);

/** Parameters that name their variable in the `name` field and may carry a default value: `item = limit`, `*rest`. */
const NAMED_PARAMETERS: ReadonlySet<string> = new Set([
  "optional_parameter",
  "keyword_parameter",
  "splat_parameter",
  "hash_splat_parameter",
  "block_parameter",
]);

/** Constructs whose own parameters and body assignments are local to them: a `{ }` or `do ... end` block, and a lambda. */
const BLOCK_SCOPES: ReadonlySet<string> = new Set(["block", "do_block", "lambda"]);

/** The nodes that list the targets of one assignment: `a, (b, *c) = ...`. */
const ASSIGNMENT_TARGET_LISTS: ReadonlySet<string> = new Set([
  "left_assignment_list",
  "rest_assignment",
  "destructured_left_assignment",
]);

/** The constructs whose `pattern` field binds the names inside it: `case ... in`, `value => pattern`, `value in pattern`. */
const PATTERN_HOLDERS: ReadonlySet<string> = new Set(["in_clause", "match_pattern", "test_pattern"]);

/**
 * Whether `leaf` names a local where it stands, whichever construct binds it: the name of a parameter (never its default
 * value), any pattern, or the target of any assignment (plain, multiple, compound, `for`, `rescue =>`). A pattern's
 * `{ name: }` key binds only without a value. The scope index models some of these, and a name that the method binds
 * is a local wherever it is bound, so one syntactic rule covers all of them.
 */
function bindsLocalAt(leaf: SyntaxNodeLike): boolean {
  if (leaf.type === "hash_key_symbol") {
    const pattern = leaf.parent;
    if (pattern?.type !== "keyword_pattern" || pattern.childForFieldName("value")) return false;
  }
  let child = leaf;
  let onlyTargets = true;
  for (let parent = leaf.parent; parent; child = parent, parent = parent.parent) {
    const type = parent.type;
    if (LOCAL_SCOPE_OWNERS.has(type)) return false;
    if (type === "destructured_parameter") return true;
    if (PARAMETER_LISTS.has(type)) return sameNode(child, leaf);
    if (NAMED_PARAMETERS.has(type)) return sameNode(parent.childForFieldName("name"), child);
    if (PATTERN_HOLDERS.has(type) && sameNode(parent.childForFieldName("pattern"), child)) return true;
    if (onlyTargets) {
      const isAssignment = type === "assignment" || type === "operator_assignment";
      if (isAssignment && sameNode(parent.childForFieldName("left"), child)) return true;
      if (type === "for" && sameNode(parent.childForFieldName("pattern"), child)) return true;
      if (type === "exception_variable") return true;
    }
    onlyTargets = onlyTargets && ASSIGNMENT_TARGET_LISTS.has(type);
  }
  return false;
}

/** Whether a parameter list binds `use`'s spelling no later than the use. */
function parameterListBindsUse(node: SyntaxNodeLike, use: SyntaxNodeLike, name = use.text): boolean {
  if (node.startIndex > use.startIndex) return false;
  if (node.type === "identifier") return node.text === name && bindsLocalAt(node);
  if (BLOCK_SCOPES.has(node.type) || LOCAL_SCOPE_OWNERS.has(node.type)) return false;
  for (const child of node.namedChildren) {
    if (parameterListBindsUse(child, use, name)) return true;
  }
  return false;
}

/** A lambda parameter is not modeled as a binding; a nearer block parameter remains modeled. */
export function rubyLambdaParameterShadows(use: SyntaxNodeLike): boolean {
  if (use.type !== "identifier") return false;
  const call = use.parent;
  const methodToken = call?.type === "call" && sameNode(call.childForFieldName("method"), use);
  if (methodToken && !rubyCallReadsLocal(use)) return false;
  let child = use;
  for (let current = use.parent; current; child = current, current = current.parent) {
    if (current.type === "singleton_method" && sameNode(current.childForFieldName("object"), child)) continue;
    if (LOCAL_SCOPE_OWNERS.has(current.type)) return false;
    if (!BLOCK_SCOPES.has(current.type)) continue;
    const parameters = current.childForFieldName("parameters");
    if (parameters && parameterListBindsUse(parameters, use)) return current.type === "lambda";
  }
  return false;
}

/** The names a `/(?<name>...)/ =~ value` match assigns as locals, or none for any other binary expression. */
function capturedNames(binary: SyntaxNodeLike): string[] {
  if (binary.childForFieldName("operator")?.text !== "=~") return [];
  const regex = binary.childForFieldName("left");
  if (regex?.type !== "regex") return [];
  return Array.from(regex.text.matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/gu), (match) => match[1]!);
}

/** Whether `scope` holds `use`, so the locals it binds are visible there. */
function holdsUse(scope: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  return scope.startIndex <= use.startIndex && use.endIndex <= scope.endIndex;
}

/** Where a local is bound, and the block or lambda it is local to, or null where it is local to the whole scope. */
type LocalSite = { start: number; block: SyntaxNodeLike | null; node: SyntaxNodeLike };

/** The locals each definition, type body, or program binds, by name: the same answer for every use in it. */
const localSitesByScope = new WeakMap<SyntaxNodeLike, ReadonlyMap<string, readonly LocalSite[]>>();

/** The innermost node whose locals a name at `node` binds in: a `def`, a class, a module, `class << self`, or the program. */
function localScopeOf(node: SyntaxNodeLike): SyntaxNodeLike {
  let top = node;
  for (let current = node.parent; current; current = current.parent) {
    if (LOCAL_SCOPE_OWNERS.has(current.type)) return current;
    top = current;
  }
  return top;
}

/**
 * Every place `scope` binds a local: a binding position, or a named capture. A nested definition has its own locals,
 * and a block or lambda keeps what it binds to itself.
 */
function localSitesOf(scope: SyntaxNodeLike): ReadonlyMap<string, readonly LocalSite[]> {
  const cached = localSitesByScope.get(scope);
  if (cached) return cached;
  const sites = new Map<string, LocalSite[]>();
  const add = (name: string, start: number, block: SyntaxNodeLike | null, node: SyntaxNodeLike): void => {
    const known = sites.get(name);
    if (known) known.push({ start, block, node });
    else sites.set(name, [{ start, block, node }]);
  };
  const pending: Array<{ node: SyntaxNodeLike; block: SyntaxNodeLike | null }> = [];
  for (const child of scope.namedChildren) pending.push({ node: child, block: null });
  while (pending.length) {
    const { node, block } = pending.pop()!;
    const type = node.type;
    if (type === "identifier" || type === "hash_key_symbol") {
      if (bindsLocalAt(node)) add(node.text, node.startIndex, block, node);
      continue;
    }
    if (LOCAL_SCOPE_OWNERS.has(type)) continue;
    if (type === "binary") for (const name of capturedNames(node)) add(name, node.startIndex, block, node);
    const inner = BLOCK_SCOPES.has(type) ? node : block;
    for (const child of node.namedChildren) pending.push({ node: child, block: inner });
  }
  localSitesByScope.set(scope, sites);
  return sites;
}

/**
 * Whether `scope` binds the local `name` at or before `use`: a binding position, or a named capture, of that name,
 * outside any block or lambda that ended before the use.
 */
function bindsNameBefore(scope: SyntaxNodeLike, name: string, use: SyntaxNodeLike): boolean {
  const sites = localSitesOf(scope).get(name);
  return !!sites?.some((site) => site.start <= use.startIndex && (!site.block || holdsUse(site.block, use)));
}

/**
 * Whether the identifier at `use` is a local variable by syntax, whichever construct binds it: a binding position
 * itself, or a name bound earlier in its definition, class body, or the program. The scope index models only some of
 * these (a plain assignment, a parameter), so a name it binds nothing for may still be a local, which a method of that
 * name cannot be. The name of a call (`name(1)`, `name { }`, `x.name`) is never a local.
 */
export function rubyNamesLocalVariable(use: SyntaxNodeLike): boolean {
  if (use.type !== "identifier") return false;
  const call = use.parent;
  if (call?.type === "call" && sameNode(call.childForFieldName("method"), use)) return rubyCallReadsLocal(use);
  return bindsLocalAt(use) || bindsNameBefore(localScopeOf(use), use.text, use);
}

/** Whether `declaration`, the name token of a definition, names a local variable, not a method or a constant. */
export function rubyDeclaresLocalVariable(declaration: SyntaxNodeLike): boolean {
  return declaration.type === "identifier" && bindsLocalAt(declaration);
}

/** A block captures an earlier local, but its parameters and newly introduced locals remain its own. */
function localSiteOwner(node: SyntaxNodeLike, scope: SyntaxNodeLike, name = node.text): SyntaxNodeLike {
  for (let current = node.parent; current && !sameNode(current, scope); current = current.parent) {
    if (!BLOCK_SCOPES.has(current.type)) continue;
    const parameters = current.childForFieldName("parameters");
    if (parameters && parameterListBindsUse(parameters, node, name)) return current;
    if (!bindsNameBefore(scope, name, current)) return current;
  }
  return scope;
}

/** Whether `statement`, one of a body, defines the method `name` for the `self` at `level`. */
function definesMethod(statement: SyntaxNodeLike, name: string, level: SelfLevel | "other"): boolean {
  if (!NAMED_DEFINITIONS.has(statement.type)) return false;
  const statementName = statement.childForFieldName("name");
  return statementName?.text === name && declarationKind(statementName) === level;
}

/** The definitions of one method, and the code between them, in the order the bodies of its type run them. */
type RedefinitionWalk = {
  definition: SyntaxNodeLike;
  name: string;
  level: SelfLevel | "other";
  latest: SyntaxNodeLike | null;
  codeSinceLatest: boolean;
  liveDefinitions: number;
  definitionLive: boolean;
  sawDefinition: boolean;
};

function redefinitionWalk(definition: SyntaxNodeLike, nameNode: SyntaxNodeLike): RedefinitionWalk {
  return {
    definition,
    name: nameNode.text,
    level: declarationKind(nameNode),
    latest: null,
    codeSinceLatest: false,
    liveDefinitions: 0,
    definitionLive: false,
    sawDefinition: false,
  };
}

/** Notes one statement of a body of the method's type: a definition of the method, or code (any but a `def` or comment). */
function noteBodyStatement(walk: RedefinitionWalk, statement: SyntaxNodeLike): void {
  if (definesMethod(statement, walk.name, walk.level)) {
    if (walk.latest && walk.codeSinceLatest) {
      walk.liveDefinitions += 1;
      walk.definitionLive ||= sameNode(walk.latest, walk.definition);
    }
    walk.latest = statement;
    walk.codeSinceLatest = false;
    walk.sawDefinition ||= sameNode(statement, walk.definition);
  } else if (statement.type !== "comment" && !NAMED_DEFINITIONS.has(statement.type)) {
    walk.codeSinceLatest = true;
  }
}

/**
 * Walks, in the order they run, the statements of every body of the file that opens the constant path `path` (`class
 * Calc` twice), and the code between them: the other statements of the program and of each namespace around the path.
 * The body of another type counts as code.
 */
function walkTypeBodies(walk: RedefinitionWalk, statements: readonly SyntaxNodeLike[], path: string): void {
  for (const statement of statements) {
    const opensType = statement.type === "class" || statement.type === "module";
    const statementPath = opensType ? declaredTypePath(statement) : null;
    const opensPath = statementPath === path;
    const enclosesPath = !opensPath && statementPath !== null && path.startsWith(`${statementPath}::`);
    if (opensPath || enclosesPath) {
      const bodyStatements = statement.childForFieldName("body")?.namedChildren ?? [];
      if (opensPath) for (const bodyStatement of bodyStatements) noteBodyStatement(walk, bodyStatement);
      else walkTypeBodies(walk, bodyStatements, path);
    } else if (statement.type !== "comment" && !NAMED_DEFINITIONS.has(statement.type)) {
      walk.codeSinceLatest = true;
    }
  }
}

/**
 * Whether `definition` is a `def` that runs beside another `def` of its type that redefines the method for the same
 * `self`, in the same body or in another body of the file that reopens the type: code runs (in those bodies or between
 * them) while each is the latest one, or after the last, so a call in a method or block body may reach either. A `def`
 * that the next one replaces before any code runs is never called.
 */
function runsBesideRedefinition(definition: SyntaxNodeLike): boolean {
  if (!NAMED_DEFINITIONS.has(definition.type)) return false;
  const nameNode = definition.childForFieldName("name");
  const body = definition.parent;
  if (!nameNode || !body) return false;
  let walk = redefinitionWalk(definition, nameNode);
  const type = body.parent;
  const path = type?.type === "class" || type?.type === "module" ? declaredTypePath(type) : null;
  if (path !== null) walkTypeBodies(walk, programOf(body).namedChildren, path);
  if (!walk.sawDefinition) {
    walk = redefinitionWalk(definition, nameNode);
    for (const statement of body.namedChildren) noteBodyStatement(walk, statement);
  }
  if (!walk.latest) return false;
  // Every call that runs after the bodies runs the last definition.
  walk.liveDefinitions += 1;
  walk.definitionLive ||= sameNode(walk.latest, definition);
  return walk.definitionLive && walk.liveDefinitions > 1;
}

/** A `def` that defines a method on a constant from outside its body: `def Foo.name`, or one in `class << Foo`. */
const OUTSIDE_CLASS_METHOD = /\bdef\s+[A-Z][\w:]*\.|\bclass\s*<<\s*[A-Z]/u;

/** A method of a type itself, keyed by the type's last name and the method's, and whether a body of the type holds it. */
type ClassMethodSite = { key: string; outside: boolean };

/**
 * Which type's own method `definition` declares: one of the type around it (`def self.name`, a `def` in `class <<
 * self`), or one defined on a constant from outside the constant's body (`def Foo.name`, a `def` in `class << Foo`).
 */
function classMethodSite(definition: SyntaxNodeLike): ClassMethodSite | null {
  const nameNode = definition.childForFieldName("name");
  if (!nameNode) return null;
  const kind = declarationKind(nameNode);
  if (kind === "other") {
    const definedOn = objectDefinedOn(nameNode);
    return definedOn ? { key: `${definedOn}\u0000${nameNode.text}`, outside: true } : null;
  }
  const owner = kind === "class" ? enclosingType(nameNode) : null;
  const typeName = owner ? typeNameOf(owner) : null;
  return typeName ? { key: `${typeName}\u0000${nameNode.text}`, outside: false } : null;
}

const classMethodDefinitionsByProgram = new WeakMap<SyntaxNodeLike, ReadonlyMap<string, readonly SyntaxNodeLike[]>>();

/** Every definition of a type's own method in a file that defines one from outside a body, by {@link classMethodSite}. */
function classMethodDefinitions(program: SyntaxNodeLike): ReadonlyMap<string, readonly SyntaxNodeLike[]> {
  const cached = classMethodDefinitionsByProgram.get(program);
  if (cached) return cached;
  const definitions = new Map<string, SyntaxNodeLike[]>();
  const pending: SyntaxNodeLike[] = OUTSIDE_CLASS_METHOD.test(program.text) ? [program] : [];
  while (pending.length) {
    const node = pending.pop()!;
    for (const child of node.namedChildren) pending.push(child);
    const site = NAMED_DEFINITIONS.has(node.type) ? classMethodSite(node) : null;
    if (!site) continue;
    const known = definitions.get(site.key);
    if (known) known.push(node);
    else definitions.set(site.key, [node]);
  }
  classMethodDefinitionsByProgram.set(program, definitions);
  return definitions;
}

/**
 * Whether the type's own method `definition` declares has another definition in its file that a call may run instead:
 * one in a body of the type against one from outside it (`def self.bar` and `def Foo.bar`), or two from outside in
 * different bodies. Definitions in the same body follow {@link runsBesideRedefinition}.
 */
function redefinedOutsideItsBody(definition: SyntaxNodeLike): boolean {
  const own = classMethodSite(definition);
  if (!own) return false;
  const others = classMethodDefinitions(programOf(definition)).get(own.key) ?? [];
  const body = definition.parent;
  for (const other of others) {
    if (sameNode(other, definition)) continue;
    if (classMethodSite(other)?.outside !== own.outside) return true;
    const inAnotherBody = !body || !sameNode(other.parent, body);
    if (own.outside && inAnotherBody) return true;
  }
  return false;
}

/**
 * Whether the type of the method `definition` declares has a body that the file opens under a condition, a block, or
 * another wrapper (`class Calc ... end if ready?`), and another body of the type defines the method for the same `self`:
 * whether the wrapped body runs, and so which definition a call reaches, is not known.
 */
function redefinedBesideConditionalBody(definition: SyntaxNodeLike): boolean {
  const nameNode = NAMED_DEFINITIONS.has(definition.type) ? definition.childForFieldName("name") : null;
  const type = definition.parent?.parent;
  const opensType = type?.type === "class" || type?.type === "module";
  if (!nameNode || !type || !opensType) return false;
  const path = declaredTypePath(type);
  if (path === null || !typeFamilies(programOf(type)).conditionalPaths.has(path)) return false;
  const level = declarationKind(nameNode);
  for (const body of typeBodiesOf(type)) {
    if (sameNode(body, type)) continue;
    const statements = body.childForFieldName("body")?.namedChildren ?? [];
    if (statements.some((statement) => definesMethod(statement, nameNode.text, level))) return true;
  }
  return false;
}

/**
 * Unsupported module singletons, separate local assignment bindings, `initialize`, which `new` and `super` call without
 * naming it, and a method that runs beside a redefinition of its type leave reference completeness unproven.
 */
export function rubyReferenceFamilyUnproven(declaration: SyntaxNodeLike): boolean {
  let method = declaration.parent;
  if (method?.type === "setter") method = method.parent;
  if (method?.type === "singleton_method" && enclosingType(declaration)?.type === "module") return true;
  if (method?.type === "method" && declaration.text === "initialize") return true;
  if (method && runsBesideRedefinition(method)) return true;
  if (method && redefinedOutsideItsBody(method)) return true;
  if (method && redefinedBesideConditionalBody(method)) return true;
  if (!rubyDeclaresLocalVariable(declaration)) return false;
  const scope = localScopeOf(declaration);
  const sites = localSitesOf(scope).get(declaration.text);
  if (!sites || sites.length < 2) return false;
  const owner = localSiteOwner(declaration, scope);
  for (const site of sites) {
    const node = site.node;
    if (sameNode(node, declaration)) continue;
    const parentType = node.parent?.type;
    if (!parentType) continue;
    const separateBinding =
      node.type === "binary" ||
      parentType === "assignment" ||
      PARAMETER_LISTS.has(parentType) ||
      NAMED_PARAMETERS.has(parentType);
    if (separateBinding && sameNode(localSiteOwner(node, scope, declaration.text), owner)) return true;
  }
  return false;
}

/** A direct type/program-body call runs before a later `def`; method and block bodies can run later. */
export function rubyMethodIsPendingAt(declaration: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  if (declaration.startIndex <= use.startIndex) return false;
  let child = use;
  for (let current = use.parent; current; child = current, current = current.parent) {
    if (current.type === "singleton_method" && sameNode(current.childForFieldName("object"), child)) continue;
    if (current.type === "method" || current.type === "singleton_method" || BLOCK_SCOPES.has(current.type))
      return false;
    if (LOCAL_SCOPE_OWNERS.has(current.type)) return true;
  }
  return true;
}

/** Whether `use` calls a method of `self` by name: a bare read, or a call with no receiver (`name(1)`, `name { }`). */
function callsSelfMethod(use: SyntaxNodeLike): boolean {
  const call = use.parent;
  if (call?.type === "call" && sameNode(call.childForFieldName("method"), use)) {
    return !call.childForFieldName("receiver");
  }
  return rubyIsBareRead(use);
}

/** A direct class or module body runs with the type as `self`, not one of its instances. */
export function rubyIsClassBodyCall(use: SyntaxNodeLike): boolean {
  if (!callsSelfMethod(use)) return false;
  for (let current = use.parent; current; current = current.parent) {
    const type = current.type;
    if (type === "method" || type === "singleton_method" || BLOCK_SCOPES.has(type)) return false;
    if (type === "class" || type === "module" || type === "singleton_class") return true;
  }
  return false;
}

/** The first arguments that make `name -x`, `name [x]`, or `name &x` an operator on a local when `name` is one. */
const OPERATOR_OPERANDS: ReadonlySet<string> = new Set([
  "block_argument",
  "unary",
  "array",
  "splat_argument",
  "hash_splat_argument",
  "heredoc_beginning",
]);

/** A receiverless command such as `name -x` can read a local; parentheses always make it a method call. */
export function rubyCallMayReadLocal(use: SyntaxNodeLike): boolean {
  const call = use.parent;
  if (call?.type !== "call" || call.childForFieldName("receiver")) return false;
  if (!sameNode(call.childForFieldName("method"), use)) return false;
  const argumentsNode = call.childForFieldName("arguments");
  const first = argumentsNode?.child(0);
  if (!first || !OPERATOR_OPERANDS.has(first.type)) return false;
  if (first.type !== "unary") return true;
  const operator = first.childForFieldName("operator")?.text;
  return operator === "-" || operator === "+";
}

/** The command's name is already bound in Ruby's local table at this position. */
export function rubyCallReadsLocal(use: SyntaxNodeLike): boolean {
  return rubyCallMayReadLocal(use) && bindsNameBefore(localScopeOf(use), use.text, use);
}

/** Whether the text after `use` starts an argument that is an operator on a local when `use` is one: `c0&x`, `c0 -x`. */
function operatorFollows(use: SyntaxNodeLike, source: string): boolean {
  let at = use.endIndex;
  if (source.charCodeAt(at) === 32) at += 1;
  const code = source.charCodeAt(at);
  return code === 38 || code === 43 || code === 45 || code === 91 || code === 42 || code === 60;
}

/**
 * Whether the identifier at `use` is a local variable that tree-sitter read as the name of a command call: `c0&mask`,
 * `c0 -c1`, `c0 [1]`. Ruby reads these as an operator on the local when the name is one, which a parser that does not
 * track locals cannot know.
 */
export function rubyIsOperatorOnLocal(use: SyntaxNodeLike, source: string): boolean {
  if (use.type !== "identifier" || !operatorFollows(use, source)) return false;
  const call = use.parent;
  if (call?.type !== "call" || call.childForFieldName("receiver")) return false;
  if (!sameNode(call.childForFieldName("method"), use)) return false;
  const first = call.childForFieldName("arguments")?.child(0);
  if (!first || !OPERATOR_OPERANDS.has(first.type)) return false;
  return bindsNameBefore(localScopeOf(use), use.text, use);
}

/** Whether `local`, the definition the lookup found for such an operator, is a local of the scope of the use. */
export function rubyReadsLocalAsOperand(use: SyntaxNodeLike, local: SyntaxNodeLike): boolean {
  return rubyCallReadsLocal(use) && sameNode(localScopeOf(use), localScopeOf(local));
}

/**
 * Whether a bare name or explicit call at `use` can call a method that `attr_reader` and its siblings generate in
 * `owner`: only inside an instance method of that class or module. A bare read bound as a local is not a method call,
 * but an explicit call (`name()`, `self.name`) ignores same-named locals and parameters. Every class of a file shares
 * the file scope, so without the owner check a reader would bind the same name in unrelated classes.
 */
export function rubyGeneratedMemberVisibleAt(owner: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  const enclosing = enclosingInstanceMethod(use);
  const isOwnersMethod =
    !!enclosing && enclosing.owner.startIndex === owner.startIndex && enclosing.owner.endIndex === owner.endIndex;
  if (!isOwnersMethod) return false;
  const readsLocalOperand = rubyCallMayReadLocal(use) && bindsNameBefore(localScopeOf(use), use.text, use);
  return !readsLocalOperand && !rubyNamesLocalVariable(use);
}

/** The class or module a block builds for the constant it is assigned to: `Base = Struct.new(:a) do ... end`. */
type FactoryType = { name: string; heritage: string[]; isModule: boolean };
const factoryTypes = new WeakMap<SyntaxNodeLike, FactoryType | null>();

function factoryTypeOf(block: SyntaxNodeLike): FactoryType | null {
  if (block.type !== "block" && block.type !== "do_block") return null;
  const known = factoryTypes.get(block);
  if (known !== undefined) return known;
  let type: FactoryType | null = null;
  const call = block.parent;
  const assignment = call?.parent;
  if (
    call &&
    assignment?.type === "assignment" &&
    sameNode(assignment.childForFieldName("right"), call) &&
    isTypeFactoryBlock(block)
  ) {
    const name = constantName(assignment.childForFieldName("left"));
    const factory = call.childForFieldName("receiver")?.text.replace(/^::/u, "");
    const base = factory === "Class" ? constantArguments(call)[0] : undefined;
    const mixins = mixinNames(block.childForFieldName("body")?.namedChildren ?? []);
    if (name) type = { name, heritage: base ? [base, ...mixins] : mixins, isModule: factory === "Module" };
  }
  factoryTypes.set(block, type);
  return type;
}

/** The name of a class or module type node, or null where it names none. */
function typeNameOf(type: SyntaxNodeLike): string | null {
  if (type.type === "class" || type.type === "module") return constantName(type.childForFieldName("name"));
  return factoryTypeOf(type)?.name ?? null;
}

function isModuleType(type: SyntaxNodeLike): boolean {
  return type.type === "module" || !!factoryTypeOf(type)?.isModule;
}

/**
 * The class or module whose body holds `node`, or null at the top level. A `class << self` body belongs to its class,
 * and the block of `Base = Struct.new(:a) do ... end` (or `Class.new`, `Module.new`) is the class or module the constant
 * names, not the type around the assignment.
 */
function enclosingType(node: SyntaxNodeLike): SyntaxNodeLike | null {
  for (let current = node.parent; current; current = current.parent) {
    const type = current.type;
    if (type === "class" || type === "module") return current;
    if ((type === "block" || type === "do_block") && factoryTypeOf(current)) return current;
  }
  return null;
}

/**
 * Whether the method declared at `declaration` belongs to the class or module whose body holds `use`, whichever body of
 * the file that opens its constant path declares it (`class Foo` twice), or both are at the top level of the file, where
 * a top-level `def` runs in the same order as the code around it.
 */
export function rubyMethodIsOwnedAt(declaration: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  const owner = enclosingType(declaration);
  const user = enclosingType(use);
  if (!owner || !user) return !owner && !user && isTopLevelMethod(declaration);
  return sameType(owner, user);
}

/** Whether two class or module bodies of one file are the same type: one body, or two that open one constant path. */
function sameType(left: SyntaxNodeLike, right: SyntaxNodeLike): boolean {
  if (sameNode(left, right)) return true;
  // A body opened under a condition may never run, so it is not known to be part of the type.
  if (!opensUnconditionally(left) || !opensUnconditionally(right)) return false;
  const name = typeNameOf(left);
  if (name === null || name !== typeNameOf(right)) return false;
  const path = declaredTypePath(left);
  return path !== null && path === declaredTypePath(right);
}

/** The nodes a class or module may sit in and still be opened whenever its file loads: the program and namespace bodies. */
const UNCONDITIONAL_TYPE_PARENTS: ReadonlySet<string> = new Set(["program", "body_statement", "class", "module"]);

/**
 * Whether the class or module `type` is opened whenever its file loads: it sits in the program or in namespace bodies,
 * not under a condition, a block, a method, or another wrapper (`class Calc ... end if ready?`). A type that a block
 * builds (`Base = Struct.new(:a) do`) counts as opened.
 */
function opensUnconditionally(type: SyntaxNodeLike): boolean {
  if (type.type !== "class" && type.type !== "module") return true;
  for (let current = type.parent; current; current = current.parent) {
    if (!UNCONDITIONAL_TYPE_PARENTS.has(current.type)) return false;
  }
  return true;
}

/** Whether `node` is the name a `def` declares (`def name`, `def self.name`), which names that definition itself. */
export function rubyIsMethodDeclarationName(node: SyntaxNodeLike): boolean {
  const definition = node.parent;
  return !!definition && NAMED_DEFINITIONS.has(definition.type) && sameNode(definition.childForFieldName("name"), node);
}

/**
 * The `name=` that `def name=(value)` declares when `node` is its name token, which spells only `name`, or null for any
 * other node. A reader `def name` binds that spelling too, so the token alone does not name the writer.
 */
export function rubySetterDeclarationOf(node: SyntaxNodeLike): SyntaxNodeLike | null {
  const setter = node.parent;
  if (setter?.type !== "setter") return null;
  return rubyIsMethodDeclarationName(setter) ? setter : null;
}

/** The class or module that `name` names in its declaration, or the block that builds the type a constant is assigned. */
function typeDeclaredAt(name: SyntaxNodeLike): SyntaxNodeLike | null {
  let written = name;
  while (written.parent?.type === "scope_resolution") written = written.parent;
  const declaration = written.parent;
  if (!declaration) return null;
  if (declaration.type === "class" || declaration.type === "module") return declaration;
  if (declaration.type !== "assignment") return null;
  const block = declaration.childForFieldName("right")?.childForFieldName("block");
  return block && factoryTypeOf(block) ? block : null;
}

/** The constant path a type declares, with the namespaces around it: `Outer::Inner` for `module Outer; class Inner`. */
function declaredTypePath(type: SyntaxNodeLike): string | null {
  const names: string[] = [];
  for (let current: SyntaxNodeLike | null = type; current; current = current.parent) {
    const namesNamespace = current.type === "class" || current.type === "module";
    if (!namesNamespace && !sameNode(current, type)) continue;
    const name = namesNamespace ? current.childForFieldName("name")?.text : typeNameOf(current);
    if (!name) return null;
    const topLevel = name.startsWith("::");
    names.unshift(topLevel ? name.slice(2) : name);
    if (topLevel) break;
  }
  return names.join("::");
}

/** What {@link objectDefinedOn} answers for a method defined on an object that is no constant. */
const ANOTHER_OBJECT = "";

/**
 * What the method declared at `method` is defined on from outside a type body: the last name of a constant (`def
 * Foo.name`, a `def` in `class << Foo`), {@link ANOTHER_OBJECT} for another object (`def obj.name`, `class << obj`), or
 * null for a method of `self`, which belongs to the body around it.
 */
function objectDefinedOn(method: SyntaxNodeLike): string | null {
  let definition = method.parent;
  if (definition?.type === "setter") definition = definition.parent;
  if (definition?.type === "singleton_method") {
    const object = definition.childForFieldName("object");
    return object?.type === "self" ? null : (constantName(object) ?? ANOTHER_OBJECT);
  }
  for (let current = definition?.parent; current; current = current.parent) {
    if (current.type === "singleton_class") {
      const value = current.childForFieldName("value");
      return value?.type === "self" ? null : (constantName(value) ?? ANOTHER_OBJECT);
    }
    const startsOtherBody =
      current.type === "class" || current.type === "module" || NAMED_DEFINITIONS.has(current.type);
    if (startsOtherBody) return null;
  }
  return null;
}

/**
 * Whether a call through the name of the type declared at `typeName` may run the method declared at `method`, at a level
 * a type name reaches (see {@link rubyTypeNameCall}): one defined on the type's constant (`def Foo.name`, a `def` in
 * `class << Foo`), one of that type's body, of another body of the file that reopens the same constant path (`class
 * Foo` twice), or of a type the file's superclasses, mixins, and modules handed to a call lead the type to (`extend
 * Helpers`, `register Helpers`), never one of a subclass or a sibling. A method defined on an object that is no constant
 * (`def klass.name`), or in a block that may run in another type (`Foo.singleton_class.class_eval do`, a DSL body), may
 * be the type's. A top-level `def` is private to every object, and a type that merely encloses the declaration (`module
 * Outer; class Inner`) gives it nothing.
 */
export function rubyTypeNameMayReach(typeName: SyntaxNodeLike, method: SyntaxNodeLike): boolean {
  const type = typeDeclaredAt(typeName);
  if (!type || rubyTypeNameCall(method) === "none") return false;
  const definedOn = objectDefinedOn(method);
  if (definedOn === ANOTHER_OBJECT) return true;
  if (definedOn !== null) return definedOn === typeNameOf(type);
  const owner = enclosingType(method);
  if (!owner) return !isTopLevelMethod(method);
  if (sameType(type, owner)) return true;
  if (definedInReboundBlock(method, owner)) return true;
  return typeMayHaveMethodsOf(type, owner, typeNameOf(owner), false);
}

/**
 * How a call through a type's name (`Config.build`) may run a method: as a method of the type itself, as an instance
 * method that something may hand to the type, or not at all.
 */
export type RubyTypeNameCall = "class-method" | "instance-method" | "none";

/**
 * How a call through a type's name may run the method declared at `declaration`: as a method of the class itself
 * (`def self.build`, a `def` in `class << self`) or one defined on an object (`def Config.build`, a `def` in
 * `class << Config`, `def klass.build`); as an instance method of a module, which `module_function`, `extend self`, or
 * `extend` may hand to a type, of a core type every class has (`class Object; def try`), of a `def` whose type the file
 * does not show (one in a block that may run with another `self`, such as `Foo.instance_eval do`), or of a class that
 * may answer the call with it (see {@link classMayAnswerWithInstanceMethod}); or not at all: an instance method of any
 * other class runs only on its instances, a method of a singleton class (`def self.name` in `class << self`) only on that
 * singleton class, and a top-level `def self.name` only on the main object.
 */
export function rubyTypeNameCall(declaration: SyntaxNodeLike): RubyTypeNameCall {
  const kind = declarationKind(declaration);
  if (kind === "class") return isMainObjectMethod(declaration) ? "none" : "class-method";
  if (kind === "other") return objectDefinedOn(declaration) === null ? "none" : "class-method";
  if (kind === "singleton-class") return "none";
  const owner = enclosingType(declaration);
  if (!owner || isModuleType(owner)) return "instance-method";
  if (definedInReboundBlock(declaration, owner)) return "instance-method";
  const ownerName = typeNameOf(owner);
  if (ownerName && UNIVERSAL_TYPES.has(ownerName)) return "instance-method";
  return classMayAnswerWithInstanceMethod(owner, declaration.text) ? "instance-method" : "none";
}

/**
 * Whether the class `owner` may answer a call through its name with its instance method `name`, by what its file shows
 * or leaves out: a superclass or mixin the file does not declare (`class Current < ActiveSupport::CurrentAttributes`),
 * levels it shares (`method_missing`, `extend self`, an `extend` of a module the file does not declare), or a call in a
 * `class << self` body that names the method (`delegate :collect?, to: :instance`).
 */
function classMayAnswerWithInstanceMethod(owner: SyntaxNodeLike, name: string): boolean {
  if (!levelEvidencePaths(owner) || typeSharesLevels(owner)) return true;
  for (const body of typeBodiesOf(owner)) {
    for (const statement of body.childForFieldName("body")?.namedChildren ?? []) {
      if (statement.type !== "singleton_class" || !singletonClassOpensSelf(statement)) continue;
      for (const call of statement.childForFieldName("body")?.namedChildren ?? []) {
        const named = call.type === "call" ? (call.childForFieldName("arguments")?.namedChildren ?? []) : [];
        if (named.some((argument) => namesMethod(argument, name))) return true;
      }
    }
  }
  return false;
}

/** Whether the call named at `property` is the target of a compound assignment: `x.total += 1`, `x.total ||= 2`. */
export function rubyCallsReaderAndWriter(property: SyntaxNodeLike): boolean {
  const call = property.parent;
  if (call?.type !== "call" || !sameNode(call.childForFieldName("method"), property)) return false;
  const assignment = call.parent;
  return assignment?.type === "operator_assignment" && sameNode(assignment.childForFieldName("left"), call);
}

/** The calls that mix a module into the class or module around them: `include Mixin`. */
const MIXIN_CALLS: ReadonlySet<string> = new Set(["include", "extend", "prepend"]);

/** Core types whose methods every object, or every class, has wherever a file reopens them: `class Object; def try`. */
const UNIVERSAL_TYPES: ReadonlySet<string> = new Set(["Object", "BasicObject", "Kernel", "Module", "Class"]);

/** The last constant of `Outer::Name`, or of a bare `Name`, or null for any other expression. */
function constantName(node: SyntaxNodeLike | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "constant") return node.text;
  return node.type === "scope_resolution" ? constantName(node.childForFieldName("name")) : null;
}

/** Whether `call` is `include Mixin`, `extend Mixin`, or `prepend Mixin` as a statement of a class or module body. */
function isHeritageStatement(call: SyntaxNodeLike): boolean {
  const method = call.childForFieldName("method");
  if (method?.type !== "identifier" || !MIXIN_CALLS.has(method.text) || call.childForFieldName("receiver"))
    return false;
  const owner = call.parent?.type === "body_statement" ? call.parent.parent : null;
  return owner?.type === "class" || owner?.type === "module";
}

/** The constants a call passes as arguments (`helpers HelperOne, Other::Two`), by last name. */
function constantArguments(call: SyntaxNodeLike): string[] {
  const names: string[] = [];
  for (const argument of call.childForFieldName("arguments")?.namedChildren ?? []) {
    const name = constantName(argument);
    if (name) names.push(name);
  }
  return names;
}

/** The constants that statements of a body mix in: `include C, D::E`. */
function mixinNames(statements: readonly SyntaxNodeLike[]): string[] {
  const names: string[] = [];
  for (const statement of statements) {
    if (statement.type !== "call" || statement.childForFieldName("receiver")) continue;
    const method = statement.childForFieldName("method");
    if (method?.type !== "identifier" || !MIXIN_CALLS.has(method.text)) continue;
    for (const argument of statement.childForFieldName("arguments")?.namedChildren ?? []) {
      const mixin = constantName(argument);
      if (mixin) names.push(mixin);
    }
  }
  return names;
}

/** The constants a class names as its superclass or mixes in from its body: `class A < B`, `include C, D::E`. */
function heritageNames(type: SyntaxNodeLike): string[] {
  const names: string[] = [];
  const superclass = constantName(type.childForFieldName("superclass")?.namedChildren[0]);
  if (superclass) names.push(superclass);
  names.push(...mixinNames(type.childForFieldName("body")?.namedChildren ?? []));
  return names;
}

/**
 * Each class or module of a file, by where it starts, mapped to the family of types its heritage links it to, and the
 * modules the file mixes into a target it does not show (`klass.extend Mixin`, a top-level `include Mixin`).
 */
type TypeFamilies = {
  families: ReadonlyMap<number, number>;
  mixedIntoUnknown: ReadonlySet<string>;
  /** The superclass and mixins each type names, by the type's name: a reopened type adds to the same entry. */
  heritage: ReadonlyMap<string, readonly string[]>;
  /** The modules of the file that a call in each type's body hands along (`register Helpers`), by the type's name. */
  handed: ReadonlyMap<string, readonly string[]>;
  /** Every class and module body of the file, by the constant path it opens. */
  bodies: ReadonlyMap<string, readonly SyntaxNodeLike[]>;
  /** The constant paths the file opens under a condition, a block, or another wrapper (`class C ... end if ready?`). */
  conditionalPaths: ReadonlySet<string>;
};
const typeFamiliesByProgram = new WeakMap<SyntaxNodeLike, TypeFamilies>();

/**
 * The classes and modules of the file that one chain of superclasses and mixins connects, as the file spells them: a
 * reopened class is one type, and a base or mixin the file declares links the two. A base the file does not declare
 * links nothing, so two classes that share an outside base stay apart.
 */
function typeFamilies(program: SyntaxNodeLike): TypeFamilies {
  const cached = typeFamiliesByProgram.get(program);
  if (cached) return cached;
  const declared: Array<{ start: number; name: string; heritage: string[]; isModule: boolean }> = [];
  const mixedIntoUnknown = new Set<string>();
  const bodies = new Map<string, SyntaxNodeLike[]>();
  const conditionalPaths = new Set<string>();
  // A module a call passes along (`klass.extend Mixin`, `helpers Mixin`) may be mixed in by it, into the type around the
  // call, or into a target the file does not show when no type surrounds it or the call has a receiver.
  const passed: Array<{ owner: string | null; name: string }> = [];
  const pending: SyntaxNodeLike[] = [program];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === "call" && !isHeritageStatement(node)) {
      const enclosing = enclosingType(node);
      const owner = enclosing ? typeNameOf(enclosing) : null;
      const receiver = !!node.childForFieldName("receiver");
      for (const name of constantArguments(node)) {
        passed.push({ owner, name });
        if (receiver) passed.push({ owner: null, name });
      }
    }
    const factory = factoryTypeOf(node);
    if (factory) {
      declared.push({ start: node.startIndex, ...factory });
    } else if (node.type === "class" || node.type === "module") {
      const name = constantName(node.childForFieldName("name"));
      if (name)
        declared.push({
          start: node.startIndex,
          name,
          heritage: heritageNames(node),
          isModule: node.type === "module",
        });
      const path = declaredTypePath(node);
      const pathBodies = path === null ? undefined : bodies.get(path);
      if (pathBodies) pathBodies.push(node);
      else if (path !== null) bodies.set(path, [node]);
      if (path !== null && !opensUnconditionally(node)) conditionalPaths.add(path);
    }
    for (const child of node.namedChildren) pending.push(child);
  }
  const known = new Set(declared.map((type) => type.name));
  const parentOf = new Map<string, string>();
  const rootOf = (name: string): string => {
    let root = name;
    for (let next = parentOf.get(root); next !== undefined; next = parentOf.get(root)) root = next;
    return root;
  };
  for (const type of declared) {
    for (const base of type.heritage) {
      if (!known.has(base)) continue;
      const left = rootOf(type.name);
      const right = rootOf(base);
      if (left !== right) parentOf.set(left, right);
    }
  }
  const modules = new Set(declared.filter((type) => type.isModule).map((type) => type.name));
  const handed = new Map<string, string[]>();
  for (const { owner, name } of passed) {
    if (!modules.has(name)) continue;
    if (owner === null || !known.has(owner)) {
      mixedIntoUnknown.add(name);
      continue;
    }
    const handedByOwner = handed.get(owner);
    if (handedByOwner) handedByOwner.push(name);
    else handed.set(owner, [name]);
    const left = rootOf(owner);
    const right = rootOf(name);
    if (left !== right) parentOf.set(left, right);
  }
  const familyIds = new Map<string, number>();
  const families = new Map<number, number>();
  for (const type of declared) {
    const family = rootOf(type.name);
    let id = familyIds.get(family);
    if (id === undefined) {
      id = familyIds.size;
      familyIds.set(family, id);
    }
    families.set(type.start, id);
  }
  const heritage = new Map<string, string[]>();
  for (const type of declared) {
    const named = heritage.get(type.name);
    if (named) named.push(...type.heritage);
    else heritage.set(type.name, [...type.heritage]);
  }
  const table = { families, mixedIntoUnknown, heritage, handed, bodies, conditionalPaths };
  typeFamiliesByProgram.set(program, table);
  return table;
}

/** Every body of the file that opens the constant path of the class or module `type`, `type` itself included. */
function typeBodiesOf(type: SyntaxNodeLike): readonly SyntaxNodeLike[] {
  const path = declaredTypePath(type);
  const bodies = path === null ? undefined : typeFamilies(programOf(type)).bodies.get(path);
  return bodies ?? [type];
}

/** The root node of the tree that holds `node`. */
function programOf(node: SyntaxNodeLike): SyntaxNodeLike {
  let top = node;
  for (let current = node.parent; current; current = current.parent) top = current;
  return top;
}

const descendantsByProgram = new WeakMap<SyntaxNodeLike, ReadonlyMap<string, ReadonlySet<string>>>();

/**
 * Each type name of a file mapped to the type names whose superclasses, mixins, and handed modules lead to it, itself
 * included: the types that have its methods, by what the file shows.
 */
function typeDescendants(program: SyntaxNodeLike): ReadonlyMap<string, ReadonlySet<string>> {
  const cached = descendantsByProgram.get(program);
  if (cached) return cached;
  const { heritage, handed } = typeFamilies(program);
  const descendants = new Map<string, Set<string>>();
  for (const name of heritage.keys()) {
    const seen = new Set<string>([name]);
    const pending = [name];
    const visit = (base: string): void => {
      if (seen.has(base)) return;
      seen.add(base);
      pending.push(base);
    };
    while (pending.length) {
      const ancestor = pending.pop()!;
      const below = descendants.get(ancestor);
      if (below) below.add(name);
      else descendants.set(ancestor, new Set([name]));
      heritage.get(ancestor)?.forEach(visit);
      handed.get(ancestor)?.forEach(visit);
    }
  }
  descendantsByProgram.set(program, descendants);
  return descendants;
}

/** Whether two sets share a member, walking the smaller one. */
function setsIntersect(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  const leftIsSmaller = left.size <= right.size;
  const smaller = leftIsSmaller ? left : right;
  const larger = leftIsSmaller ? right : left;
  for (const name of smaller) {
    if (larger.has(name)) return true;
  }
  return false;
}

/**
 * Whether the methods of `owner`, a class or module of the same file as `user`, may be methods of `user`. A core type's
 * methods belong to every object, a module the file mixes into a type it does not show may be anyone's, and a type the
 * file's heritage does not place leaves the answer open. Otherwise the file's superclasses, mixins, and handed modules
 * must lead from `user` to `owner`, or, where `user` may be one of several types (the `self` of a bare name), from some
 * type of the file to both: the base calls a method its subclass declares, a mixin one of its includer or of another
 * mixin of it. Two classes that only share a base or a mixin never reach each other's methods.
 */
function typeMayHaveMethodsOf(
  user: SyntaxNodeLike,
  owner: SyntaxNodeLike,
  ownerName: string | null,
  anyTypeOfSelf: boolean,
): boolean {
  if (ownerName && UNIVERSAL_TYPES.has(ownerName)) return true;
  const program = programOf(user);
  const { families, mixedIntoUnknown } = typeFamilies(program);
  if (ownerName && mixedIntoUnknown.has(ownerName)) return true;
  const ownerFamily = families.get(owner.startIndex);
  const userFamily = families.get(user.startIndex);
  if (ownerFamily === undefined || userFamily === undefined) return true;
  if (ownerFamily !== userFamily) return false;
  const userName = typeNameOf(user);
  if (!ownerName || !userName) return true;
  const descendants = typeDescendants(program);
  const haveOwnerMethods = descendants.get(ownerName);
  if (!haveOwnerMethods || haveOwnerMethods.has(userName)) return true;
  if (!anyTypeOfSelf) return false;
  const haveUserMethods = descendants.get(userName);
  return !haveUserMethods || setsIntersect(haveOwnerMethods, haveUserMethods);
}

/**
 * Whether a bare name at `use` can call the method declared at `declaration`. Every class and module of a file shares
 * the file scope, so a method named in one would bind the same name in an unrelated type that comes before or after
 * it. A top-level method belongs to every object; a method of a type is named from inside that type, or from a type that
 * the file's superclasses and mixins relate to it (see {@link typeMayHaveMethodsOf}). At the top level only a module's
 * method can be mixed into `main`. A type the file's heritage does not place leaves the answer open, as the file cannot
 * show an unrelated type.
 */
export function rubyMethodVisibleAt(declaration: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  const owner = enclosingType(declaration);
  if (!owner) return true;
  const ownerName = typeNameOf(owner);
  if (ownerName && UNIVERSAL_TYPES.has(ownerName)) return true;
  const user = enclosingType(use);
  if (!user) return isModuleType(owner);
  if (sameType(owner, user)) return true;
  return typeMayHaveMethodsOf(user, owner, ownerName, true);
}

/**
 * Syntax that may give a class its own `new`: `def self.new`, `def Foo.new`, a `def new` in `class << self`, an alias to
 * `new` (`alias_method :new, :build`, `alias new build`), or a method defined as `new` (`define_singleton_method(:new)`).
 */
const CLASS_NEW_DEFINITION =
  /\bdef\s+(?:[\w:]+\.)?new\b|\balias(?:_method)?\s*\(?\s*:?["']?new\b|\bdefine_(?:singleton_)?method\s*\(?\s*:?["']?new\b/u;
const customConstructorsByProgram = new WeakMap<SyntaxNodeLike, ReadonlySet<string>>();

/** The calls that define or alias a method their first argument names: `define_singleton_method(:new) { }`. */
const METHOD_DEFINING_CALLS: ReadonlySet<string> = new Set([
  "alias_method",
  "define_method",
  "define_singleton_method",
]);

/** Whether an alias or a defining call names a method `new`: `alias new build`, `alias_method :new, :build`. */
function definesNewByName(node: SyntaxNodeLike): boolean {
  if (node.type === "alias") {
    const destination = node.namedChildren[0];
    return !!destination && (destination.text === "new" || namesMethod(destination, "new"));
  }
  if (node.type !== "call") return false;
  const method = node.childForFieldName("method")?.text;
  if (!method || !METHOD_DEFINING_CALLS.has(method)) return false;
  const first = node.childForFieldName("arguments")?.namedChildren[0];
  return !!first && namesMethod(first, "new");
}

/**
 * The types of a file that may declare their own `new` (`def self.new`, a `def new` in `class << self`, `def Foo.new`,
 * `alias_method :new, :build`, `define_singleton_method(:new)`), by last name, with {@link ANOTHER_OBJECT} for one
 * defined on an object that is no constant (`def klass.new`) or where the file does not name the object.
 */
function customConstructorTypes(program: SyntaxNodeLike): ReadonlySet<string> {
  const cached = customConstructorsByProgram.get(program);
  if (cached) return cached;
  const types = new Set<string>();
  const pending: SyntaxNodeLike[] = CLASS_NEW_DEFINITION.test(program.text) ? [program] : [];
  while (pending.length) {
    const node = pending.pop()!;
    for (const child of node.namedChildren) pending.push(child);
    if (definesNewByName(node)) {
      // The type whose `self` the alias or call works on; a `self` the file does not name may be any type's.
      types.add((node.type === "call" ? receiverTypeName(node) : selfTypeNameAt(node)) ?? ANOTHER_OBJECT);
      continue;
    }
    const name = NAMED_DEFINITIONS.has(node.type) ? node.childForFieldName("name") : null;
    if (name?.text !== "new") continue;
    const kind = declarationKind(name);
    if (kind === "other") {
      const definedOn = objectDefinedOn(name);
      if (definedOn !== null) types.add(definedOn);
    } else if (kind === "class") {
      const owner = enclosingType(name);
      const ownerName = owner ? typeNameOf(owner) : null;
      if (ownerName) types.add(ownerName);
    }
  }
  customConstructorsByProgram.set(program, types);
  return types;
}

/**
 * Whether `Name.new` may return something other than a new instance of the constant `name` names: its file declares a
 * `new` of that type's own, or of a superclass or mixin the file gives it, or one on an object it does not name.
 */
export function rubyConstructorMayBeCustom(name: SyntaxNodeLike): boolean {
  const program = programOf(name);
  const custom = customConstructorTypes(program);
  if (!custom.size) return false;
  const typeName = constantName(name);
  // A `new` defined on an object the file does not name may be any type's.
  if (!typeName || custom.has(ANOTHER_OBJECT)) return true;
  if (custom.has(typeName)) return true;
  const descendants = typeDescendants(program);
  for (const type of custom) {
    if (descendants.get(type)?.has(typeName)) return true;
  }
  return false;
}

/** Whether `statement` is a bare `module_function` or one naming methods, which hands methods of a module to itself. */
function isModuleFunctionStatement(statement: SyntaxNodeLike): boolean {
  if (statement.type === "identifier") return statement.text === "module_function";
  if (statement.type !== "call" || statement.childForFieldName("receiver")) return false;
  return statement.childForFieldName("method")?.text === "module_function";
}

const moduleFunctionFilesByProgram = new WeakMap<SyntaxNodeLike, boolean>();

/** Whether a file may hand a module its own instance methods (`module_function`, `extend self`), by its text alone. */
export function rubyFileMayHandModuleMethods(program: SyntaxNodeLike): boolean {
  let known = moduleFunctionFilesByProgram.get(program);
  if (known === undefined) {
    known = /\bmodule_function\b|\bextend\s+self\b/u.test(program.text);
    moduleFunctionFilesByProgram.set(program, known);
  }
  return known;
}

/** Whether `statement` is `extend self`, which hands every instance method of a module to the module. */
function isExtendSelfStatement(statement: SyntaxNodeLike): boolean {
  if (statement.type !== "call" || statement.childForFieldName("receiver")) return false;
  if (statement.childForFieldName("method")?.text !== "extend") return false;
  return !!statement.childForFieldName("arguments")?.namedChildren.some((argument) => argument.type === "self");
}

/** Whether `statement` of a type body declares a method of the type itself named `name` (`def self.name`). */
function declaresOwnMethodNamed(statement: SyntaxNodeLike, name: string): boolean {
  if (definesMethod(statement, name, "class")) return true;
  if (statement.type !== "singleton_class" || !singletonClassOpensSelf(statement)) return false;
  return !!statement.childForFieldName("body")?.namedChildren.some((child) => definesMethod(child, name, "class"));
}

/** Whether `statement` makes the module's own method `name` private: `private_class_method :name`. */
function hidesClassMethod(statement: SyntaxNodeLike, name: string): boolean {
  if (statement.type !== "call" || statement.childForFieldName("receiver")) return false;
  if (statement.childForFieldName("method")?.text !== "private_class_method") return false;
  return !!statement.childForFieldName("arguments")?.namedChildren.some((argument) => namesMethod(argument, name));
}

/**
 * Whether a call through the name of the module declared at `typeName` to `member` (`Tools.calculate`) can only run an
 * instance method of the module: a body of the module in its file hands its instance methods to it (`extend self`,
 * `module_function`), no body declares a method of the module itself named `member` or makes it private
 * (`private_class_method :member`), and the file defines none from outside a body (`def Tools.member`). Another file may
 * still open the module, which only the caller can check.
 */
export function rubyModuleCallReachesInstanceMethod(typeName: SyntaxNodeLike, member: string): boolean {
  const type = typeDeclaredAt(typeName);
  if (type?.type !== "module") return false;
  let handsOwnMethods = false;
  for (const body of typeBodiesOf(type)) {
    for (const statement of body.childForFieldName("body")?.namedChildren ?? []) {
      if (declaresOwnMethodNamed(statement, member) || hidesClassMethod(statement, member)) return false;
      handsOwnMethods ||= isModuleFunctionStatement(statement) || isExtendSelfStatement(statement);
    }
  }
  if (!handsOwnMethods) return false;
  const definitions = classMethodDefinitions(programOf(type)).get(`${typeNameOf(type)}\u0000${member}`) ?? [];
  return !definitions.some((definition) => classMethodSite(definition)?.outside);
}

/** The constant path that the class or module declared at `typeName` opens (`Outer::Tools`), or null. */
export function rubyDeclaredTypePath(typeName: SyntaxNodeLike): string | null {
  const type = typeDeclaredAt(typeName);
  return type ? declaredTypePath(type) : null;
}

/** Whether a literal argument names the method `name`: `:name` or `"name"` (`module_function :name`, `delegate :name`). */
function namesMethod(argument: SyntaxNodeLike, name: string): boolean {
  if (argument.type === "simple_symbol") return argument.text.slice(1) === name;
  const content = argument.type === "string" ? argument.namedChildren : [];
  return content.length === 1 && content[0]!.type === "string_content" && content[0]!.text === name;
}

/**
 * Whether `declaration` is an instance method of the module declared at `typeName`, in the same file, that the module
 * hands to itself: its body runs `extend self`, a bare `module_function` before the `def`, or a `module_function` that
 * names it (`module_function :calculate`).
 */
export function rubyModuleFunctionDeclaredAt(typeName: SyntaxNodeLike, declaration: SyntaxNodeLike): boolean {
  const type = typeDeclaredAt(typeName);
  if (type?.type !== "module") return false;
  const method = declaration.parent;
  const body = method?.type === "method" ? method.parent : null;
  if (!method || !body?.parent) return false;
  if (!sameType(type, body.parent)) return false;
  const name = declaration.text;
  for (const statement of body.namedChildren) {
    if (isExtendSelfStatement(statement)) return true;
    if (!isModuleFunctionStatement(statement)) continue;
    const handsLaterDefinitions = statement.type === "identifier";
    if (handsLaterDefinitions) {
      if (statement.startIndex < method.startIndex) return true;
      continue;
    }
    const named = statement.childForFieldName("arguments")?.namedChildren ?? [];
    if (named.some((argument) => namesMethod(argument, name))) return true;
  }
  return false;
}

const typeBuildersByProgram = new WeakMap<SyntaxNodeLike, boolean>();

/** Whether the file may build a type with a block (`Base = Struct.new(:a) do ... end`), so a method may bind in one. */
export function rubyMayBuildTypesWithBlocks(program: SyntaxNodeLike): boolean {
  let known = typeBuildersByProgram.get(program);
  if (known === undefined) {
    known = /\b(?:Struct|Class|Module|Data)\.new\b/u.test(program.text);
    typeBuildersByProgram.set(program, known);
  }
  return known;
}

/** Whether `declaration` names a method of a type that a block builds (`Base = Struct.new(:a) do def run ... end`). */
export function rubyIsBlockTypeMethod(declaration: SyntaxNodeLike): boolean {
  const owner = enclosingType(declaration);
  return !!owner && owner.type !== "class" && owner.type !== "module";
}

const topLevelIncludesByProgram = new WeakMap<SyntaxNodeLike, ReadonlySet<string>>();

/** The constants the file's top-level `include` statements mix into `Object`, so code outside any type reaches them. */
function topLevelIncludeNames(program: SyntaxNodeLike): ReadonlySet<string> {
  let names = topLevelIncludesByProgram.get(program);
  if (!names) {
    const includes = program.namedChildren.filter(
      (statement) => statement.type === "call" && statement.childForFieldName("method")?.text === "include",
    );
    names = new Set(mixinNames(includes));
    topLevelIncludesByProgram.set(program, names);
  }
  return names;
}

/** Whether code outside any type reaches the methods of `owner`: a core type, or a module its file includes at the top level. */
function topLevelMixes(owner: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  const name = typeNameOf(owner);
  if (!name) return false;
  return UNIVERSAL_TYPES.has(name) || (isModuleType(owner) && topLevelIncludeNames(programOf(use)).has(name));
}

/** The type and every superclass and mixin it names, through the types its file declares. */
function ancestorNames(user: SyntaxNodeLike): ReadonlySet<string> {
  const { heritage } = typeFamilies(programOf(user));
  const names = new Set<string>();
  const pending: string[] = [];
  const userName = typeNameOf(user);
  if (userName) {
    names.add(userName);
    pending.push(userName);
  }
  while (pending.length) {
    for (const base of heritage.get(pending.pop()!) ?? []) {
      if (names.has(base)) continue;
      names.add(base);
      pending.push(base);
    }
  }
  return names;
}

/**
 * Whether a bare name at `use` can call the method declared at `declaration` in another file. A top-level method belongs
 * to every object. A method of a type is named from inside that type, or from a type whose superclasses and mixins name
 * it in the file of the use; nothing else connects a class to a type declared elsewhere, so a class that never names a
 * module does not reach its methods.
 */
export function rubyOtherFileMethodReaches(declaration: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  const owner = enclosingType(declaration);
  if (!owner) return isTopLevelMethod(declaration);
  const ownerName = typeNameOf(owner);
  if (!ownerName) return false;
  if (UNIVERSAL_TYPES.has(ownerName)) return true;
  const user = enclosingType(use);
  if (!user) return topLevelMixes(owner, use);
  return ancestorNames(user).has(ownerName);
}

/** Whether `self` at `use` is an instance of the enclosing class, as inside an instance method, rather than the class. */
export function rubySelfIsInstanceAt(use: SyntaxNodeLike): boolean {
  return enclosingInstanceMethod(use) !== null;
}

/** Parents whose identifier children name something other than a value: `alias new old`, `undef name`, `def name=(v)`. */
const NAME_LIST_PARENTS: ReadonlySet<string> = new Set(["alias", "undef", "setter"]);

/** Definitions whose `name` field is the name they declare, not a use. */
const NAMED_DEFINITIONS: ReadonlySet<string> = new Set(["method", "singleton_method"]);

/** Whether `use` is the operand of `defined?`, which asks about a name without calling it. */
function isDefinedOperand(use: SyntaxNodeLike): boolean {
  let operand = use;
  let parent = use.parent;
  while (parent?.type === "parenthesized_statements") {
    operand = parent;
    parent = parent.parent;
  }
  if (parent?.type !== "unary" || !sameNode(parent.childForFieldName("operand"), operand)) return false;
  return parent.childForFieldName("operator")?.text === "defined?";
}

/**
 * Whether the identifier at `use` stands where a bare read does, judged from its parent alone: not the name of a call,
 * a definition, or an `alias` or `undef` operand.
 */
function rubyIsBareReadPosition(use: SyntaxNodeLike): boolean {
  if (use.type !== "identifier") return false;
  const parent = use.parent;
  if (!parent || NAME_LIST_PARENTS.has(parent.type)) return false;
  if (parent.type === "call" && sameNode(parent.childForFieldName("method"), use)) return false;
  return !(NAMED_DEFINITIONS.has(parent.type) && sameNode(parent.childForFieldName("name"), use));
}

/**
 * Whether the identifier at `use` is a bare read: a name that stands where a value does, and so is a local variable or a
 * call of a method of `self` with no receiver, arguments, or parentheses. A declaration, a binding position, the name of
 * a call, an `alias` or `undef` operand, and the operand of `defined?` are not.
 */
export function rubyIsBareRead(use: SyntaxNodeLike): boolean {
  return rubyIsBareReadPosition(use) && !bindsLocalAt(use) && !isDefinedOperand(use);
}

/**
 * Whether `method`, a `def object.name`, defines a method of the class or module itself: the object is `self`, or the
 * constant the type around it names (`def Config.build` in `class Config`). Any other object is another receiver.
 */
function singletonDefinesTypeMethod(method: SyntaxNodeLike): boolean {
  const object = method.childForFieldName("object");
  if (object?.type === "self") return true;
  const name = constantName(object);
  const owner = enclosingType(method);
  return !!name && !!owner && name === typeNameOf(owner);
}

/** Whether `class << object` opens the singleton class of `self`, which is the class around it. */
function singletonClassOpensSelf(singletonClass: SyntaxNodeLike): boolean {
  return singletonClass.childForFieldName("value")?.type === "self";
}

/**
 * Whose methods a call through `self` reaches: an instance's, the class's own (`def self.name`), or those of the class's
 * singleton class (`def self.name` in a `class << self` body).
 */
type SelfLevel = "instance" | "class" | "singleton-class";

/** The `self` a `class << self` body runs with, one level above the `self` around it, or null above that. */
const LIFTED_LEVEL: Readonly<Record<SelfLevel, SelfLevel | null>> = {
  instance: "class",
  class: "singleton-class",
  "singleton-class": null,
};

/**
 * What `self` is at `use`: an instance inside an instance method; the class in its body and inside `def self.name`; the
 * class's singleton class in a `class << self` body and inside a `def self.name` there, where a `def name` runs on the
 * class. Unknown where a block hands the code another `self` (`instance_eval`, `Struct.new`, a DSL call's block), where
 * a `def object.name` or `class << object` runs on another object, or at the top level. With `surelyKeptBlocksOnly`,
 * every block but one that surely keeps `self` leaves it unknown.
 */
function selfKindAt(use: SyntaxNodeLike, surelyKeptBlocksOnly = false): SelfLevel | null {
  let kind: SelfLevel | null = null;
  // `def Config.name` runs on the class whatever `class << self` bodies hold it; `def self.name` runs on their `self`.
  let onConstant = false;
  for (let current = use.parent; current; current = current.parent) {
    const type = current.type;
    if (type === "block" || type === "do_block") {
      const otherSelf = surelyKeptBlocksOnly ? !blockSurelyKeepsSelf(current) : rubyBlockMayRebindSelf(current);
      if (otherSelf) return null;
    }
    if (kind === null) {
      if (type === "method") {
        kind = "instance";
      } else if (type === "singleton_method") {
        if (!singletonDefinesTypeMethod(current)) return null;
        kind = "class";
        onConstant = current.childForFieldName("object")?.type !== "self";
      } else if (type === "class" || type === "module") {
        return "class";
      } else if (type === "singleton_class") {
        if (!singletonClassOpensSelf(current)) return null;
        kind = "singleton-class";
      }
    } else if (type === "singleton_class") {
      if (!singletonClassOpensSelf(current)) return null;
      if (!onConstant) kind = LIFTED_LEVEL[kind];
      if (kind === null) return null;
    } else if (type === "class" || type === "module") {
      return kind;
    }
  }
  return kind;
}

/**
 * Whose method the declaration at `declaration` is: an instance method; a method of the class itself (`def self.name`,
 * `def Config.name`, or a `def` in `class << self`); one of the class's singleton class (`def self.name` in
 * `class << self`); or a method of another object (`def object.name`, a `def` in `class << object`), which no bare name
 * reaches.
 */
function declarationKind(declaration: SyntaxNodeLike): SelfLevel | "other" {
  let kind: SelfLevel | null = null;
  let onConstant = false;
  for (let current = declaration.parent; current; current = current.parent) {
    const type = current.type;
    if (kind === null && type === "singleton_method") {
      if (!singletonDefinesTypeMethod(current)) return "other";
      kind = "class";
      onConstant = current.childForFieldName("object")?.type !== "self";
    } else if (type === "singleton_class") {
      if (!singletonClassOpensSelf(current)) return "other";
      if (!onConstant) kind = LIFTED_LEVEL[kind ?? "instance"];
      if (kind === null) return "other";
    } else if (type === "class" || type === "module") {
      return kind ?? "instance";
    }
  }
  return kind ?? "instance";
}

/**
 * Whether a bare name at `use` calls the method declared at `declaration` on the `self` there: an instance method is
 * called from an instance method, a singleton method from a singleton method, and a method of the singleton class from
 * a `class << self` body. A top-level method belongs to every `self`. Where `self` is unknown, the call is unproven.
 */
export function rubyBareCallReaches(declaration: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  const kind = selfKindAt(use);
  if (kind === null) return false;
  const declared = declarationKind(declaration);
  if (declared === "other") return false;
  const owner = enclosingType(declaration);
  if (!owner) return true;
  if (isModuleType(owner) && !enclosingType(use) && !topLevelMixes(owner, use)) return false;
  return kind === declared;
}

/** What {@link selfTypeNameAt} answers at the top level of a file, where `self` is the main object, not a type. */
const TOP_LEVEL_SELF = "";

/** The methods that run their block in the body of their receiver: `Tools.class_eval { extend self }`. */
const BODY_EVALUATIONS: ReadonlySet<string> = new Set([
  "class_eval",
  "module_eval",
  "class_exec",
  "module_exec",
  "instance_eval",
  "instance_exec",
]);

/**
 * The name of the type that is `self` at `node`: the class or module around it (a `class << self` body and a method body
 * run on it too), the constant whose body a block around it is evaluated in (`Tools.class_eval do`), null where another
 * block may run it with a `self` the file does not name, or {@link TOP_LEVEL_SELF} at the top level.
 */
function selfTypeNameAt(node: SyntaxNodeLike): string | null {
  for (let current = node.parent; current; current = current.parent) {
    const type = current.type;
    if (type === "class" || type === "module") return typeNameOf(current);
    if (type !== "block" && type !== "do_block") continue;
    if (factoryTypeOf(current)) return typeNameOf(current);
    if (blockSurelyKeepsSelf(current)) continue;
    return evaluatedTypeName(current);
  }
  return TOP_LEVEL_SELF;
}

/** The type whose body `block` is evaluated in (`Tools.class_eval do`, `Tools.instance_eval do`), or null. */
function evaluatedTypeName(block: SyntaxNodeLike): string | null {
  const call = block.parent;
  if (call?.type !== "call") return null;
  const method = call.childForFieldName("method")?.text;
  if (!method || !BODY_EVALUATIONS.has(method)) return null;
  return receiverTypeName(call);
}

/**
 * The type a call works on: the constant its receiver chain starts at (`Tools.singleton_class.include`), or the type
 * that is `self` there for a call with no receiver or one on `self`; null for any other receiver (`klass.extend`).
 */
function receiverTypeName(call: SyntaxNodeLike): string | null {
  let root = call.childForFieldName("receiver");
  if (!root) return selfTypeNameAt(call);
  while (root.type === "call") {
    const next = root.childForFieldName("receiver");
    if (!next) return null;
    root = next;
  }
  return root.type === "self" ? selfTypeNameAt(call) : constantName(root);
}

/** Methods that hand a module to their receiver (`include`, `extend`, `prepend`) or its own methods (`module_function`). */
const LEVEL_SHARING_METHODS: ReadonlySet<string> = new Set([...MIXIN_CALLS, "module_function"]);

/** Calls that run the method their first argument names: `Tools.send(:extend, Tools)`. */
const NAMED_SENDS: ReadonlySet<string> = new Set(["send", "public_send", "__send__"]);

/**
 * The level-sharing method a call runs, with the arguments it hands that method: its own (`extend self`), or those after
 * the literal method name of a reflective call (`Tools.send(:extend, Tools)`). Null for any other call.
 */
function levelSharingCallParts(call: SyntaxNodeLike): { method: string; handed: readonly SyntaxNodeLike[] } | null {
  const method = call.childForFieldName("method")?.text;
  if (!method) return null;
  const sharing = LEVEL_SHARING_METHODS.has(method);
  if (!sharing && !NAMED_SENDS.has(method)) return null;
  const passed = call.childForFieldName("arguments")?.namedChildren ?? [];
  if (sharing) return { method, handed: passed };
  // A symbol or plain string names the method, as it names an attribute (`:extend`, `"extend"`).
  const sent = passed[0] ? attributeName(passed[0]) : null;
  if (!sent || !LEVEL_SHARING_METHODS.has(sent)) return null;
  return { method: sent, handed: passed.slice(1) };
}

/**
 * What a file shows of the types whose calls on `self` may reach either level: those that may run their instance methods
 * on themselves or answer any call, and where the file declares each type.
 */
type LevelEvidence = {
  /**
   * The type names: `extend self` or `module_function` in a body of the type, a mixin of the type's own name, of a module
   * that shares, or of one the file does not declare (`Tools.singleton_class.include(Tools)`, `send(:extend, Tools)`,
   * `extend extension`), and a `method_missing`. A module handed to a receiver the file does not name is listed too, as
   * the receiver may be its own type.
   */
  shared: ReadonlySet<string>;
  /**
   * Any type of the file may share: a `method_missing` or `module_function` serves a `self` the file does not name, or a
   * receiver the file does not name gets a module that shares or that the file does not declare (`m.extend(m)`).
   */
  anyType: boolean;
  /** The constant paths each type name is declared at, null where one is not written out. */
  paths: ReadonlyMap<string, readonly (string | null)[]>;
};
const levelEvidenceByProgram = new WeakMap<SyntaxNodeLike, LevelEvidence>();

/** Reads every type declaration, level-sharing call, `module_function`, and `method_missing` of the file once. */
function levelEvidence(program: SyntaxNodeLike): LevelEvidence {
  const cached = levelEvidenceByProgram.get(program);
  if (cached) return cached;
  const paths = new Map<string, (string | null)[]>();
  const calls: Array<{ call: SyntaxNodeLike; method: string; handed: readonly SyntaxNodeLike[] }> = [];
  const sharedSelves: SyntaxNodeLike[] = [];
  const answeringSelves: SyntaxNodeLike[] = [];
  const pending: SyntaxNodeLike[] = [program];
  while (pending.length) {
    const node = pending.pop()!;
    for (const child of node.namedChildren) pending.push(child);
    const type = node.type;
    if (type === "class" || type === "module" || factoryTypeOf(node)) {
      const name = typeNameOf(node);
      const declaredAt = name ? paths.get(name) : undefined;
      if (declaredAt) declaredAt.push(declaredTypePath(node));
      else if (name) paths.set(name, [declaredTypePath(node)]);
    }
    if (type === "call") {
      const parts = levelSharingCallParts(node);
      if (parts) calls.push({ call: node, ...parts });
    } else if (type === "identifier") {
      if (node.text === "module_function" && node.parent?.type === "body_statement") sharedSelves.push(node);
    } else if (NAMED_DEFINITIONS.has(type)) {
      if (node.childForFieldName("name")?.text === "method_missing") answeringSelves.push(node);
    }
  }
  const shared = new Set<string>();
  let anyType = false;
  // A `self` the file does not name may be any type; the main object at the top level is none.
  const share = (name: string | null): void => {
    if (name === null) anyType = true;
    else if (name !== TOP_LEVEL_SELF) shared.add(name);
  };
  for (const node of sharedSelves) share(selfTypeNameAt(node));
  for (const node of answeringSelves) {
    // A top-level `method_missing` serves every object.
    const owner = selfTypeNameAt(node);
    share(owner === TOP_LEVEL_SELF ? null : owner);
  }
  const links: Array<{ receiver: string; mixin: string }> = [];
  // The modules handed to a receiver the file does not name: one that shares lets any type share.
  const handedToAnyType: string[] = [];
  for (const { call, method, handed } of calls) {
    const receiver = receiverTypeName(call);
    if (receiver === TOP_LEVEL_SELF) continue;
    if (method === "module_function") {
      share(receiver);
      continue;
    }
    for (const argument of handed) {
      const mixin = argument.type === "self" ? selfTypeNameAt(call) : constantName(argument);
      const declaredMixin = mixin !== null && paths.has(mixin);
      if (receiver === null) {
        // The receiver may be any type, the module's own one included; a module the file does not declare may answer
        // any call for it.
        if (!declaredMixin) {
          anyType = true;
        } else {
          shared.add(mixin);
          handedToAnyType.push(mixin);
        }
        continue;
      }
      // A type that mixes in itself, or a module the file does not declare, may share its levels.
      if (!declaredMixin || mixin === receiver) shared.add(receiver);
      else links.push({ receiver, mixin });
    }
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const { receiver, mixin } of links) {
      if (shared.has(receiver) || !shared.has(mixin)) continue;
      shared.add(receiver);
      grew = true;
    }
  }
  if (handedToAnyType.some((mixin) => shared.has(mixin))) anyType = true;
  const evidence = { shared, anyType, paths };
  levelEvidenceByProgram.set(program, evidence);
  return evidence;
}

/** Whether any of `names` is in `shared`. */
function anyNameShared(names: ReadonlySet<string>, shared: ReadonlySet<string>): boolean {
  if (!shared.size) return false;
  for (const name of names) {
    if (shared.has(name)) return true;
  }
  return false;
}

const levelSharingByType = new WeakMap<SyntaxNodeLike, boolean>();

/**
 * Whether a call on the type itself can reach its instance methods, and an instance method can run on the type, by what
 * the file shows: the type, or a superclass or mixin the file gives it, is one of the file's level-sharing types, or a
 * module is handed to a `self` the file does not name.
 */
function typeSharesLevels(type: SyntaxNodeLike): boolean {
  let shares = levelSharingByType.get(type);
  if (shares === undefined) {
    const evidence = levelEvidence(programOf(type));
    shares = evidence.anyType || anyNameShared(ancestorNames(type), evidence.shared);
    levelSharingByType.set(type, shares);
  }
  return shares;
}

const evidencePathsByType = new WeakMap<SyntaxNodeLike, readonly string[] | null>();

/**
 * The constant paths of every body that may hand the class `type` its own methods or answer any call for it, where its
 * file declares all of them: the class and each superclass and mixin it names, transitively. Null for a module, whose
 * own methods any file may hand to it (`Tools.extend(Tools)`), and for a class with a superclass or mixin the file does
 * not declare, or a declaration whose path is not written out.
 */
function levelEvidencePaths(type: SyntaxNodeLike): readonly string[] | null {
  if (isModuleType(type)) return null;
  let paths = evidencePathsByType.get(type);
  if (paths === undefined) {
    paths = declaredHeritagePaths(type);
    evidencePathsByType.set(type, paths);
  }
  return paths;
}

/**
 * The constant paths of the class `type` and of each superclass and mixin it names, transitively, or null where the file
 * declares one of them nowhere or without a written path.
 */
function declaredHeritagePaths(type: SyntaxNodeLike): string[] | null {
  const declared = levelEvidence(programOf(type)).paths;
  const names = ancestorNames(type);
  if (!names.size) return null;
  const paths: string[] = [];
  for (const name of names) {
    const typePaths = declared.get(name);
    if (!typePaths) return null;
    for (const path of typePaths) {
      if (path === null) return null;
      paths.push(path);
    }
  }
  return paths;
}

/**
 * The constant paths of the bodies that may share the levels of the class around `use`, when its file shows all of
 * them (see {@link levelEvidencePaths}); null at the top level, in a module, or where the file does not declare one.
 * Another file that opens one of these paths may still hand the class its own methods.
 */
export function rubySelfLevelEvidencePaths(use: SyntaxNodeLike): readonly string[] | null {
  const type = enclosingType(use);
  return type ? levelEvidencePaths(type) : null;
}

/** Whether a block between `declaration` and its type may run the `def` with another `self`, as a DSL body may. */
function definedInReboundBlock(declaration: SyntaxNodeLike, owner: SyntaxNodeLike): boolean {
  for (let current = declaration.parent; current && !sameNode(current, owner); current = current.parent) {
    if ((current.type === "block" || current.type === "do_block") && !blockSurelyKeepsSelf(current)) return true;
  }
  return false;
}

/**
 * Whether a call of a method of `self` at `use` cannot run the method declared at `declaration`, by what the file shows:
 * `self` there is proven and the method is defined on another level of it (an instance method from a singleton method or
 * a `class << self` body, a singleton method from an instance method), or on another object. A block that may be a body
 * evaluated elsewhere (a receiverless DSL call's, a lambda's) leaves `self` unproven. So does a module, whose own methods
 * any file may hand to it, a class with a superclass or mixin the file does not declare, and a type that may hand its
 * instance methods to itself or answer any call by what the file shows (see {@link typeSharesLevels}). Another file
 * that opens one of {@link rubySelfLevelEvidencePaths} may still share the levels, which only the caller can check.
 */
export function rubyBareCallMisses(declaration: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  if (!callsSelfMethod(use)) return false;
  const kind = selfKindAt(use, true);
  if (kind === null || declarationKind(declaration) === kind) return false;
  const owner = enclosingType(declaration);
  if (!owner || definedInReboundBlock(declaration, owner)) return false;
  if (!levelEvidencePaths(owner)) return false;
  return !typeSharesLevels(owner);
}

/** Whether `declaration` is an instance method of a module, which `extend` or `include` hands to either level of a type. */
function isMixableMethod(declaration: SyntaxNodeLike): boolean {
  const owner = enclosingType(declaration);
  if (!owner || !isModuleType(owner)) return false;
  return declarationKind(declaration) === "instance";
}

/**
 * Whether a call of a method of `self` at `use` that no method of its own type proves may still run the method declared
 * at `declaration`: a top-level method, or one of a base class or mixin, that the `self` there reaches. A module's
 * instance method may be a class method of a type that extends the module (`extend Macros`).
 */
export function rubyUnplacedSelfCallMayReach(declaration: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  const sameFile = programOf(declaration) === programOf(use);
  if (sameFile && rubyMethodIsOwnedAt(declaration, use)) return false;
  const visible = sameFile ? rubyMethodVisibleAt(declaration, use) : rubyOtherFileMethodReaches(declaration, use);
  if (!visible) return false;
  return isMixableMethod(declaration) || rubyBareCallReaches(declaration, use);
}

/**
 * Whether the method declared at `declaration` is a top-level method: not inside a class, a module, a block, or another
 * method, so it belongs to every object. A `def` in a block belongs to whatever type the block builds or evaluates in.
 */
function isTopLevelMethod(declaration: SyntaxNodeLike): boolean {
  const definition = definitionOf(declaration);
  return definition?.type === "method" && outsideEveryBody(definition);
}

/** Whether `declaration` names a top-level `def self.name`: a method of the main object, which no type name reaches. */
function isMainObjectMethod(declaration: SyntaxNodeLike): boolean {
  const definition = definitionOf(declaration);
  if (definition?.type !== "singleton_method") return false;
  return definition.childForFieldName("object")?.type === "self" && outsideEveryBody(definition);
}

/** The `def` whose name `declaration` is, through the `setter` of `def name=(value)`. */
function definitionOf(declaration: SyntaxNodeLike): SyntaxNodeLike | null {
  const parent = declaration.parent;
  return parent?.type === "setter" ? parent.parent : parent;
}

/** Whether `definition` sits in no class, module, block, or other method. */
function outsideEveryBody(definition: SyntaxNodeLike): boolean {
  for (let current = definition.parent; current; current = current.parent) {
    if (NOT_TOP_LEVEL_PARENTS.has(current.type)) return false;
  }
  return true;
}

/** The nodes a method sits inside of when it does not belong to every object. */
const NOT_TOP_LEVEL_PARENTS: ReadonlySet<string> = new Set([
  "class",
  "module",
  "singleton_class",
  "block",
  "do_block",
  "lambda",
  "method",
  "singleton_method",
]);

/** Whether `call` is the target of a plain or multiple assignment (`x.name = value`, `a.x, b.y = 1, 2`). */
function isAssignmentTarget(call: SyntaxNodeLike): boolean {
  const parent = call.parent;
  if (parent?.type === "assignment") return sameNode(parent.childForFieldName("left"), call);
  if (parent?.type !== "left_assignment_list") return false;
  const assignment = parent.parent;
  return assignment?.type === "assignment" && sameNode(assignment.childForFieldName("left"), parent);
}

/**
 * The method a call's method name invokes: `x.name = value` calls the writer `name=`, and every other use calls
 * `name`. A compound assignment (`x.name += 1`) reads through `name` first, so it keeps the reader's name.
 */
export function rubyInvokedMethodName(property: SyntaxNodeLike): string {
  const call = property.parent;
  const isMethodOfCall = call?.type === "call" && sameNode(call.childForFieldName("method"), property);
  return isMethodOfCall && isAssignmentTarget(call) ? `${property.text}=` : property.text;
}

/** A call site writes the setter `name=` as `name`; every other method name is written as declared. */
export function rubyUseSiteMethodName(declared: string): string {
  return declared.length > 1 && declared.endsWith("=") ? declared.slice(0, -1) : declared;
}

/** The name token of `def name=(value)` spells `name` but declares the writer `name=`. */
export function rubyIsSetterDeclaration(node: SyntaxNodeLike): boolean {
  return node.parent?.type === "setter";
}

/** `empty?`, `save!`, and `name=` are stored in a Bloom filter as `empty`, `save`, and `name`. */
export function rubyBloomProbeName(name: string): string {
  return name.replace(/[?!=]$/u, "");
}

/** Calls whose literal arguments name methods, rather than arbitrary Ruby symbols. */
const METHOD_NAME_CALLS: Readonly<Record<string, "all" | "first" | "dynamic" | "alias">> = {
  module_function: "all",
  private: "all",
  protected: "all",
  public: "all",
  private_class_method: "all",
  public_class_method: "all",
  alias_method: "alias",
  define_method: "first",
  attr_reader: "all",
  attr_writer: "all",
  attr_accessor: "all",
  send: "dynamic",
  __send__: "dynamic",
  public_send: "dynamic",
  "respond_to?": "dynamic",
  method: "dynamic",
};

/** Literal method names never occupy the local-variable namespace, including bare `alias` operands. */
export function rubyMethodNameLiteral(node: SyntaxNodeLike): boolean {
  return (
    node.type === "simple_symbol" ||
    node.type === "bare_symbol" ||
    node.type === "string_content" ||
    node.parent?.type === "alias"
  );
}

/** The naming call or alias holding this literal; nested interpolation remains dynamic. */
export function rubyMethodNameOwner(node: SyntaxNodeLike): SyntaxNodeLike | null {
  if (!rubyMethodNameLiteral(node)) return null;
  if (node.parent?.type === "alias") return node.parent;
  let argument = node;
  for (let parent = argument.parent; parent; parent = argument.parent) {
    if (parent.type === "alias") return parent;
    if (parent.type === "argument_list") {
      const call = parent.parent;
      if (call?.type !== "call") return null;
      const method = call.childForFieldName("method")?.text;
      if (!method || !Object.hasOwn(METHOD_NAME_CALLS, method)) return null;
      const firstOnly = METHOD_NAME_CALLS[method] === "first" || METHOD_NAME_CALLS[method] === "dynamic";
      if (firstOnly && !sameNode(parent.namedChildren[0], argument)) return null;
      return call;
    }
    const literalWrapper =
      parent.type === "string" ||
      parent.type === "delimited_symbol" ||
      parent.type === "interpolation" ||
      parent.type === "bare_symbol" ||
      parent.type === "symbol_array" ||
      parent.type === "array" ||
      parent.type === "splat_argument";
    if (!literalWrapper) return null;
    argument = parent;
  }
  return null;
}

/** An alias destination declares a new method, never a reference of an earlier same-named method. */
export function rubyMethodNameIsAliasDestination(node: SyntaxNodeLike): boolean {
  const naming = rubyMethodNameOwner(node);
  if (!naming) return false;
  let destination: SyntaxNodeLike | undefined;
  if (naming.type === "alias") destination = naming.namedChildren[0];
  else {
    const method = naming.childForFieldName("method")?.text;
    if (!method || METHOD_NAME_CALLS[method] !== "alias") return false;
    destination = naming.childForFieldName("arguments")?.namedChildren[0];
  }
  if (!destination || destination.type === "splat_argument") return false;
  return destination.startIndex <= node.startIndex && node.endIndex <= destination.endIndex;
}

/** Only literal symbols in a direct class/module naming statement prove the method owner. */
export function rubyMethodNameIsStatic(node: SyntaxNodeLike): boolean {
  const naming = rubyMethodNameOwner(node);
  if (!naming) return false;
  if (node.type !== "simple_symbol" && node.type !== "identifier") return false;
  if (naming.type === "call") {
    const method = naming.childForFieldName("method")?.text;
    if (!method || METHOD_NAME_CALLS[method] === "dynamic" || method === "attr_accessor") return false;
    const receiver = naming.childForFieldName("receiver");
    if (receiver && receiver.type !== "self") return false;
    if (node.parent?.type !== "argument_list") return false;
  }
  let statement = naming;
  const modifier = naming.parent;
  if (modifier?.type === "if_modifier" || modifier?.type === "unless_modifier") statement = modifier;
  const body = statement.parent?.type === "argument_list" ? macroBody(statement) : statement.parent;
  if (body?.type !== "body_statement") return false;
  const owner = body.parent;
  if (owner?.type === "class" || owner?.type === "module") return true;
  return owner?.type === "singleton_class" && singletonClassOpensSelf(owner);
}

/** The method namespace a static naming statement addresses. */
function methodNameNamespaceMatches(declaration: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  const naming = rubyMethodNameOwner(use)!;
  const method = naming.childForFieldName("method")?.text;
  const namesClassMethod = method === "private_class_method" || method === "public_class_method";
  const singletonBody = declarationKind(naming) === "class";
  const expectedKind = namesClassMethod || singletonBody ? "class" : "instance";
  return declarationKind(declaration) === expectedKind;
}

/** A proven naming statement selects only a matching method of its own source class/module. */
export function rubyMethodNameRefersTo(declaration: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  if (!rubyMethodNameIsStatic(use) || !methodNameNamespaceMatches(declaration, use)) return false;
  return programOf(declaration) === programOf(use) && rubyMethodIsOwnedAt(declaration, use);
}

/** Inherited or mixed-in names stay uncertain, while unrelated owners and method namespaces are excluded. */
export function rubyMethodNameMayReferTo(declaration: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  if (!rubyMethodNameIsStatic(use)) {
    const naming = rubyMethodNameOwner(use);
    if (naming?.type !== "call") return true;
    const method = naming.childForFieldName("method")?.text;
    if (!method || METHOD_NAME_CALLS[method] === "dynamic") return true;
    const receiver = naming.childForFieldName("receiver");
    if (receiver && receiver.type !== "self") return true;
    if (!macroBody(naming, true)) return true;
  }
  if (!methodNameNamespaceMatches(declaration, use)) return false;
  return programOf(declaration) === programOf(use)
    ? rubyMethodVisibleAt(declaration, use)
    : rubyOtherFileMethodReaches(declaration, use);
}

/** Arbitrary symbols and strings are not identifier candidates; known method-naming arguments are. */
export function rubyReferenceSpelling(name: string, node?: SyntaxNodeLike): string | null {
  if (node && rubyMethodNameLiteral(node)) {
    const owner = rubyMethodNameOwner(node);
    if (!owner) return null;
    const declaration = node.type === "string_content" && node.parent?.type === "string" ? node.parent : node;
    if (owner.type === "call") {
      let declarations = generatedDeclarationStartsByCall.get(owner);
      if (!declarations) {
        const members = rubyGeneratedMembers(owner);
        if (members.length) {
          const starts = new Set<number>();
          for (const member of members) starts.add(member.node.startIndex);
          generatedDeclarationStartsByCall.set(owner, starts);
          declarations = starts;
        }
      }
      if (declarations?.has(declaration.startIndex)) return null;
    }
    const methodName = node.type === "simple_symbol" ? name.slice(1) : name;
    return rubyUseSiteMethodName(methodName);
  }
  return name;
}

/** Rename only the symbol's name, leaving its colon intact. */
export function rubyReferenceRange(node: SyntaxNodeLike): Range {
  const prefix = node.type === "simple_symbol" ? 1 : 0;
  const start = node.startPosition;
  const end = node.endPosition;
  return {
    start: {
      line: start.row + 1,
      column: start.column + 1 + prefix,
      index: node.startIndex + prefix,
    },
    end: { line: end.row + 1, column: end.column + 1, index: node.endIndex },
  };
}
