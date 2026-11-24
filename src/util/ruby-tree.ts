import type { GeneratedMember, SyntaxNodeLike } from "../languages/types.js";

/** What each `attr_*` macro defines for one attribute name. */
const ATTRIBUTE_MACROS: Readonly<Record<string, { reader: boolean; writer: boolean }>> = {
  attr_reader: { reader: true, writer: false },
  attr_writer: { reader: false, writer: true },
  attr_accessor: { reader: true, writer: true },
};

/** `attr_reader` accepts the names that a method can have, not an operator or a `?`, `!`, or `=` name. */
const ATTRIBUTE_NAME = /^[A-Za-z_\u0080-\u{10FFFF}][A-Za-z0-9_\u0080-\u{10FFFF}]*$/u;

const NO_MEMBERS: readonly GeneratedMember[] = [];

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
 * other call around it (`memoize attr_reader :name`, a modifier, a block) gives null: the names it defines are unproven.
 */
function macroBody(call: SyntaxNodeLike): SyntaxNodeLike | null {
  let statement = call;
  const list = call.parent;
  if (list?.type === "argument_list") {
    const wrapper = list.parent;
    const visibility = wrapper?.childForFieldName("method");
    const isVisibilityCall =
      wrapper?.type === "call" &&
      !wrapper.childForFieldName("receiver") &&
      visibility?.type === "identifier" &&
      VISIBILITY_CALLS.has(visibility.text);
    if (!isVisibilityCall) return null;
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
  return members.length ? members : NO_MEMBERS;
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
 * The methods a file defines that run the block of their call in the caller's `self`: one that yields, or takes a `&block`
 * and does not evaluate it (`instance_eval(&block)`, `define_method(name, &block)`, `Class.new(&block)`), directly or by
 * handing it to a method of the file that does.
 */
const yieldingMethodsByProgram = new WeakMap<SyntaxNodeLike, ReadonlySet<string>>();

function yieldingMethodsOf(program: SyntaxNodeLike): ReadonlySet<string> {
  const known = yieldingMethodsByProgram.get(program);
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
  const names = new Set<string>();
  for (const use of uses) {
    if ((use.yields || use.blockParam !== null) && !evaluating.has(use.name)) names.add(use.name);
  }
  yieldingMethodsByProgram.set(program, names);
  return names;
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
  return !yieldingMethodsOf(root).has(methodName);
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
function parameterListBindsUse(node: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  if (node.startIndex > use.startIndex) return false;
  if (node.type === "identifier") return node.text === use.text && bindsLocalAt(node);
  if (BLOCK_SCOPES.has(node.type) || LOCAL_SCOPE_OWNERS.has(node.type)) return false;
  for (const child of node.namedChildren) {
    if (parameterListBindsUse(child, use)) return true;
  }
  return false;
}

/** A lambda parameter is not modeled as a binding; a nearer block parameter remains modeled. */
export function rubyLambdaParameterShadows(use: SyntaxNodeLike): boolean {
  if (use.type !== "identifier") return false;
  const call = use.parent;
  if (call?.type === "call" && sameNode(call.childForFieldName("method"), use)) return false;
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
type LocalSite = { start: number; block: SyntaxNodeLike | null };

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
  const add = (name: string, start: number, block: SyntaxNodeLike | null): void => {
    const known = sites.get(name);
    if (known) known.push({ start, block });
    else sites.set(name, [{ start, block }]);
  };
  const pending: Array<{ node: SyntaxNodeLike; block: SyntaxNodeLike | null }> = [];
  for (const child of scope.namedChildren) pending.push({ node: child, block: null });
  while (pending.length) {
    const { node, block } = pending.pop()!;
    const type = node.type;
    if (type === "identifier" || type === "hash_key_symbol") {
      if (bindsLocalAt(node)) add(node.text, node.startIndex, block);
      continue;
    }
    if (LOCAL_SCOPE_OWNERS.has(type)) continue;
    if (type === "binary") for (const name of capturedNames(node)) add(name, node.startIndex, block);
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
  if (call?.type === "call" && sameNode(call.childForFieldName("method"), use)) return false;
  return bindsLocalAt(use) || bindsNameBefore(localScopeOf(use), use.text, use);
}

/** Whether `declaration`, the name token of a definition, names a local variable, not a method or a constant. */
export function rubyDeclaresLocalVariable(declaration: SyntaxNodeLike): boolean {
  return declaration.type === "identifier" && bindsLocalAt(declaration);
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
  return !!first && OPERATOR_OPERANDS.has(first.type);
}

/** Whether the text after `use` starts an argument that is an operator on a local when `use` is one: `c0&x`, `c0 -x`. */
function operatorFollows(use: SyntaxNodeLike, source: string): boolean {
  let at = use.endIndex;
  if (source.charCodeAt(at) === 32) at += 1;
  const code = source.charCodeAt(at);
  return code === 38 || code === 45 || code === 91 || code === 42 || code === 60;
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
export function rubyReadsLocalAsOperand(use: SyntaxNodeLike, local: SyntaxNodeLike, source: string): boolean {
  return rubyIsOperatorOnLocal(use, source) && sameNode(localScopeOf(use), localScopeOf(local));
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

/** Whether the method declared at `declaration` belongs to the very class or module whose body holds `use`. */
export function rubyMethodIsOwnedAt(declaration: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  const owner = enclosingType(declaration);
  const user = enclosingType(use);
  return !!owner && !!user && sameNode(owner, user);
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
  for (const { owner, name } of passed) {
    if (!modules.has(name)) continue;
    if (owner === null || !known.has(owner)) {
      mixedIntoUnknown.add(name);
      continue;
    }
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
  const table = { families, mixedIntoUnknown, heritage };
  typeFamiliesByProgram.set(program, table);
  return table;
}

/** The root node of the tree that holds `node`. */
function programOf(node: SyntaxNodeLike): SyntaxNodeLike {
  let top = node;
  for (let current = node.parent; current; current = current.parent) top = current;
  return top;
}

/**
 * Whether a bare name at `use` can call the method declared at `declaration`. Every class and module of a file shares
 * the file scope, so a method named in one would bind the same name in an unrelated type that comes before or after
 * it. A top-level method belongs to every object; a method of a type is named from inside that type, or from a type that
 * the file's superclasses and mixins connect to it (the base calls a method its subclass declares, the including
 * module one of its includer). At the top level only a module's method can be mixed into `main`. A type the file's
 * heritage does not place leaves the answer open, as the file cannot show an unrelated type.
 */
export function rubyMethodVisibleAt(declaration: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  const owner = enclosingType(declaration);
  if (!owner) return true;
  const ownerName = typeNameOf(owner);
  if (ownerName && UNIVERSAL_TYPES.has(ownerName)) return true;
  const user = enclosingType(use);
  if (!user) return isModuleType(owner);
  if (sameNode(owner, user)) return true;
  const { families, mixedIntoUnknown } = typeFamilies(programOf(user));
  if (ownerName && mixedIntoUnknown.has(ownerName)) return true;
  const ownerFamily = families.get(owner.startIndex);
  const userFamily = families.get(user.startIndex);
  return ownerFamily === undefined || userFamily === undefined || ownerFamily === userFamily;
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
 * What `self` is at `use`: an instance inside an instance method, the class inside `def self.name` or a `class << self`
 * body, and unknown where a block hands the code another `self` (`instance_eval`, `Struct.new`, a DSL call's block), where
 * a `def object.name` or `class << object` runs on another object, or where no method holds it.
 */
function selfKindAt(use: SyntaxNodeLike): "instance" | "class" | null {
  let kind: "instance" | "class" | null = null;
  for (let current = use.parent; current; current = current.parent) {
    const type = current.type;
    if ((type === "block" || type === "do_block") && rubyBlockMayRebindSelf(current)) return null;
    if (kind === null) {
      if (type === "method") {
        kind = "instance";
      } else if (type === "singleton_method") {
        if (!singletonDefinesTypeMethod(current)) return null;
        kind = "class";
      } else if (type === "class" || type === "module" || type === "singleton_class") {
        return null;
      }
    } else if (type === "singleton_class") {
      if (!singletonClassOpensSelf(current)) return null;
      kind = "class";
    } else if (type === "class" || type === "module") {
      return kind;
    }
  }
  return kind;
}

/**
 * Whose method the declaration at `declaration` is: an instance method, a method of the class itself (`def self.name`,
 * or a `def` in `class << self`), or a method of another object (`def object.name`), which no bare name reaches.
 */
function declarationKind(declaration: SyntaxNodeLike): "instance" | "class" | "other" {
  for (let current = declaration.parent; current; current = current.parent) {
    if (current.type === "singleton_method") return singletonDefinesTypeMethod(current) ? "class" : "other";
    if (current.type === "singleton_class") return singletonClassOpensSelf(current) ? "class" : "other";
    if (current.type === "class" || current.type === "module") return "instance";
  }
  return "instance";
}

/**
 * Whether a bare name at `use` calls the method declared at `declaration` on the `self` there: an instance method is
 * called from an instance method, and a singleton method from a singleton method. A top-level method belongs to every
 * `self`. Where `self` is unknown, the call is unproven.
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

/**
 * Whether the method declared at `declaration` is a top-level method: not inside a class, a module, a block, or another
 * method, so it belongs to every object. A `def` in a block belongs to whatever type the block builds or evaluates in.
 */
function isTopLevelMethod(declaration: SyntaxNodeLike): boolean {
  let definition = declaration.parent;
  if (definition?.type === "setter") definition = definition.parent;
  if (definition?.type !== "method") return false;
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
