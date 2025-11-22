import type { Language } from "tree-sitter";
import Ruby from "tree-sitter-ruby";
import type { LanguageDefinition } from "../types.js";

const LangRuby = Ruby as unknown as Language;

export const RUBY_DEF: LanguageDefinition = {
  id: "ruby",
  extensions: [".rb"],
  grammar: () => LangRuby,
  structure: {
    blocks: [
      { type: "class", nameQuery: "name: (constant) @chunk.name", captureId: "class" },
      { type: "module", nameQuery: "name: (constant) @chunk.name", captureId: "module" },
      { type: "method", nameQuery: "name: (identifier) @chunk.name", captureId: "method" },
      { type: "singleton_method", nameQuery: "name: (identifier) @chunk.name", captureId: "method" }
    ],
    splitPoints: ["if", "unless", "case", "while", "until", "for", "begin"],
    comments: ["comment"]
  },
  graph: {
    imports: `
      (call method: (identifier) @method arguments: (argument_list (string (string_content) @mod))) (#match? @method "require|require_relative") @stmt
    `,
    exports: `
      (class name: (constant) @name)
      (module name: (constant) @name)
      (method name: (identifier) @name)
    `,
    locals: `
      (class name: (constant) @name)
      (module name: (constant) @name)
      (method name: (identifier) @name)
      (assignment left: (identifier) @name)
    `,
    importBindings: ""
  },
  nodeTypes: {
    identifier: ["identifier", "constant"],
  }
};

