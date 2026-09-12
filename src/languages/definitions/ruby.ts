import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";

export const RUBY_DEF: LanguageDefinition = {
  id: "ruby",
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
      (call method: (identifier) @method arguments: (argument_list (string (string_content) @mod)) (#match? @method "^(require|require_relative|load|autoload)$")) @stmt
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
  classifyDefinition: (node) => {
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
  isDeclarationName: (node) => {
    const p = node.parent;
    if (!p) return false;
    if (p.type === "class" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "module" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "method" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "singleton_method" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "assignment" && p.childForFieldName("left")?.id === node.id) return true;
    return false;
  },
};
registerLanguage(RUBY_DEF);
