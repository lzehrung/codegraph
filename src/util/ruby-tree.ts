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

/**
 * The methods `attr_reader`, `attr_writer`, and `attr_accessor` define: `name` for a reader and `name=` for a writer,
 * each at the argument token that names it. Only a receiverless call in the body of a class or module counts, with
 * symbol or plain string arguments; a call under a modifier, a block, or another call is not indexed. A method the same
 * body declares with `def` after the call replaces the generated one in Ruby, so it is not generated; a `def` before
 * the call is replaced by it.
 */
export function rubyGeneratedMembers(call: SyntaxNodeLike): readonly GeneratedMember[] {
  if (call.type !== "call") return NO_MEMBERS;
  const body = call.parent;
  if (body?.type !== "body_statement") return NO_MEMBERS;
  const owner = body.parent;
  if (owner?.type !== "class" && owner?.type !== "module") return NO_MEMBERS;
  const method = call.childForFieldName("method");
  if (method?.type !== "identifier" || call.childForFieldName("receiver")) return NO_MEMBERS;
  const macroName = method.text;
  const macro = Object.hasOwn(ATTRIBUTE_MACROS, macroName) ? ATTRIBUTE_MACROS[macroName] : undefined;
  const argumentList = call.childForFieldName("arguments");
  if (!macro || !argumentList) return NO_MEMBERS;
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

function isBlockWithOtherSelf(block: SyntaxNodeLike): boolean {
  const call = block.parent;
  if (call?.type !== "call") return false;
  const methodName = call.childForFieldName("method")?.text;
  if (!methodName) return false;
  if (methodName === "instance_eval" || methodName === "instance_exec") return true;
  const receiver = call.childForFieldName("receiver");
  if (receiver && receiver.type !== "self" && Object.hasOwn(OTHER_CLASS_EVAL_METHODS, methodName)) return true;
  const factoryOwners = Object.hasOwn(NEW_CLASS_BLOCK_FACTORIES, methodName)
    ? NEW_CLASS_BLOCK_FACTORIES[methodName]
    : undefined;
  return !!factoryOwners && !!receiver && Object.hasOwn(factoryOwners, receiver.text);
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

/** Whether `binary` is `/(?<name>...)/ =~ value`, which assigns the local `name` when it matches. */
function capturesName(binary: SyntaxNodeLike, name: string): boolean {
  if (binary.childForFieldName("operator")?.text !== "=~") return false;
  const regex = binary.childForFieldName("left");
  return regex?.type === "regex" && regex.text.includes(`(?<${name}>`);
}

/** Whether `scope` holds `use`, so the locals it binds are visible there. */
function holdsUse(scope: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  return scope.startIndex <= use.startIndex && use.endIndex <= scope.endIndex;
}

/**
 * Whether `method` binds the local `name` at or before `use`: a binding position, or a named capture, of that name. A
 * nested definition has its own locals, and a block or lambda that does not hold `use` has ended: what it binds is
 * local to it.
 */
function bindsNameBefore(method: SyntaxNodeLike, name: string, use: SyntaxNodeLike): boolean {
  const pending: SyntaxNodeLike[] = [...method.namedChildren];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.startIndex > use.startIndex) continue;
    const type = node.type;
    if (type === "identifier" || type === "hash_key_symbol") {
      if (node.endIndex - node.startIndex === name.length && node.text === name && bindsLocalAt(node)) return true;
      continue;
    }
    if (type === "binary" && capturesName(node, name)) return true;
    if (LOCAL_SCOPE_OWNERS.has(type)) continue;
    if (BLOCK_SCOPES.has(type) && !holdsUse(node, use)) continue;
    for (const child of node.namedChildren) pending.push(child);
  }
  return false;
}

/**
 * Whether a bare name at `use` can call a method that `attr_reader` and its siblings generate in `owner`: only inside
 * an instance method of that class or module, and only when that method has not bound a local of the same name before
 * the use (the conservative answer: a name the method binds anywhere above is treated as that local). Every class of a
 * file shares the file scope, so without this a reader would bind the same name in unrelated classes.
 */
export function rubyGeneratedMemberVisibleAt(owner: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  const enclosing = enclosingInstanceMethod(use);
  const isOwnersMethod =
    !!enclosing && enclosing.owner.startIndex === owner.startIndex && enclosing.owner.endIndex === owner.endIndex;
  return isOwnersMethod && !bindsNameBefore(enclosing.method, use.text, use);
}

/** Whether `self` at `use` is an instance of the enclosing class, as inside an instance method, rather than the class. */
export function rubySelfIsInstanceAt(use: SyntaxNodeLike): boolean {
  return enclosingInstanceMethod(use) !== null;
}

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
