import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { isNameFieldOnParent } from "./shared.js";

export const RUBY_DEF: LanguageDefinition = {
  id: "ruby",
  usesQueryDrivenLocals: true,
  extensions: [".rb", ".rbw", ".rake", ".gemspec"],
  structure: {
    blocks: [
      {
        type: "class",
        nameQuery: "name: [(constant) (scope_resolution)] @chunk.name",
        captureId: "class",
      },
      {
        type: "module",
        nameQuery: "name: [(constant) (scope_resolution)] @chunk.name",
        captureId: "module",
      },
      {
        type: "method",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "method",
      },
      {
        type: "singleton_method",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "method",
      },
    ],
    splitPoints: ["if", "unless", "case", "while", "until", "for", "begin"],
    comments: ["comment"],
  },
  graph: {
    imports: `
      (call method: (identifier) @method arguments: (argument_list (string (string_content) @from)) (#match? @method "^(require|require_relative|load|autoload)$")) @stmt
    `,
    exports: `
      (class name: [(constant) (scope_resolution)] @name)
      (module name: [(constant) (scope_resolution)] @name)
      (method name: [(identifier) (setter)] @name)
      (singleton_method name: [(identifier) (setter)] @name)
      (assignment left: (constant) @name)
    `,
    locals: `
      (class name: [(constant) (scope_resolution)] @name)
      (module name: [(constant) (scope_resolution)] @name)
      (method name: [(identifier) (setter)] @name)
      (singleton_method name: [(identifier) (setter)] @name)
      (assignment left: (identifier) @name)
      (assignment left: (constant) @name)
    `,
    importBindings: `
      ((call method: (identifier) @method arguments: (argument_list (string (string_content) @from))) @stmt (#match? @method "^(require|require_relative|load|autoload)$"))
    `,
  },
  nodeTypes: {
    identifier: ["identifier", "constant"],
    memberExpression: "call",
  },
  supportsCrossModuleSymbols: true,
  membersAreImplicitlyInScope: true,
  // Query-driven locals capture the declared name inside a `class`, `module`, `method`, or
  // `singleton_method`, so classification must read the parent type the same way the scope
  // walker's structural handling does.
  classifyDefinition: (node) => {
    const parentType = node.parent?.type;
    if (parentType === "class" || parentType === "module") return "class";
    if (parentType === "method" || parentType === "singleton_method") return "method";
    const assignment = node.parent;
    const value = assignment?.childForFieldName("right");
    if (
      assignment?.type === "assignment" &&
      assignment.childForFieldName("left")?.id === node.id &&
      value?.type === "call" &&
      value.childForFieldName("receiver")?.text === "Struct" &&
      value.childForFieldName("method")?.text === "new"
    ) {
      return "class";
    }
    return "variable";
  },
  scopeDeclarationNames: (node) => node.type === "constant" && node.parent?.type === "assignment",
  createsFunctionScope: (node) => node.type === "method" || node.type === "singleton_method",
  createsBlockScope: (node) => node.type === "do_block" || node.type === "block",
  isDeclarationName: (node) =>
    isNameFieldOnParent(node, ["class", "module", "method", "singleton_method"]) ||
    isNameFieldOnParent(node, ["assignment"], "left"),
};
registerLanguage(RUBY_DEF);
