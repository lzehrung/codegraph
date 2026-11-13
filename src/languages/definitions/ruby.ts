import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import {
  rubyBloomProbeName,
  rubyGeneratedMemberVisibleAt,
  rubyGeneratedMembers,
  rubyInvokedMethodName,
  rubyIsSetterDeclaration,
  rubySelfIsInstanceAt,
  rubyUseSiteMethodName,
} from "../../util/ruby-tree.js";
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
    // `@accessor` is the name token of a possible `attr_*` call. A pattern with no children compiles as fast as the
    // others; nesting it under class and module bodies added about 20 ms to every process. `generatedMembers` checks
    // that the call is a direct body statement.
    locals: `
      (class name: [(constant) (scope_resolution)] @name)
      (module name: [(constant) (scope_resolution)] @name)
      (method name: [(identifier) (setter)] @name)
      (singleton_method name: [(identifier) (setter)] @name)
      (assignment left: (identifier) @name)
      (assignment left: (constant) @name)
      ((identifier) @accessor (#any-of? @accessor "attr_reader" "attr_writer" "attr_accessor"))
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
  generatedMembers: rubyGeneratedMembers,
  generatedMembersMarker: "attr_",
  generatedMemberVisibleAt: rubyGeneratedMemberVisibleAt,
  selfIsInstanceAt: rubySelfIsInstanceAt,
  invokedMemberName: rubyInvokedMethodName,
  useSiteMemberName: rubyUseSiteMethodName,
  isDeclarationSpelling: rubyIsSetterDeclaration,
  bloomProbeName: rubyBloomProbeName,
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
