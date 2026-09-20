import type { LanguageDefinition } from "../types.js";
import { graphCapture } from "../graph-captures.js";
import { registerLanguage } from "../registry.js";
import { classifyByParentType, isNameFieldOnParent, matchesParentTypePairs } from "./shared.js";
import { cssLikeGraph } from "./css-like.js";

const from = graphCapture("from");
const stmt = graphCapture("stmt");
const cssGraph = cssLikeGraph();

const sassImportQueries = `
      (import_statement (_ (string_value) ${from})) ${stmt}
      (use_statement (string_value) ${from}) ${stmt}
      (use_statement (_ (string_value) ${from})) ${stmt}
      (forward_statement (string_value) ${from}) ${stmt}
      (forward_statement (_ (string_value) ${from})) ${stmt}
    `;

const sassLocalQueries = `
      (mixin_statement name: (identifier) @name)
      (function_statement name: (identifier) @name)
      ((declaration (property_name) @name) (#match? @name "^[$]"))
      (selectors (placeholder (identifier) @name))
    `;

export const SCSS_DEF: LanguageDefinition = {
  id: "scss",
  extensions: [".scss"],
  usesQueryDrivenLocals: true,
  structure: {
    blocks: [
      { type: "rule_set", captureId: "rule" },
      { type: "mixin_statement", captureId: "mixin" },
      { type: "function_statement", captureId: "function" },
      { type: "media_statement", captureId: "media" },
      { type: "keyframes_statement", captureId: "keyframes" },
    ],
    splitPoints: ["rule_set", "mixin_statement", "function_statement"],
    comments: ["comment", "js_comment"],
  },
  graph: {
    imports: `${cssGraph.imports}${sassImportQueries}`,
    exports: `
      (stylesheet (mixin_statement name: (identifier) @name))
      (stylesheet (function_statement name: (identifier) @name))
      ((stylesheet (declaration (property_name) @name)) (#match? @name "^[$]"))
      (stylesheet (rule_set (selectors (placeholder (identifier) @name))))
    `,
    locals: `${sassLocalQueries}${cssGraph.locals}`,
    importBindings: `${cssGraph.importBindings}${sassImportQueries}`,
  },
  nodeTypes: {
    identifier: ["identifier", "variable", "class_name", "id_name", "property_name"],
  },
  classifyDefinition: classifyByParentType({
    mixin_statement: "function",
    function_statement: "function",
  }),
  isDeclarationName: (node) =>
    isNameFieldOnParent(node, ["mixin_statement", "function_statement"]) ||
    (node.parent?.type === "declaration" && node.type === "property_name" && node.text.startsWith("$")) ||
    // A placeholder in a selector list is a declaration. `@extend %name` is a use;
    // the pinned grammar currently wraps that form in ERROR rather than extend_statement.
    (node.parent?.type === "placeholder" && node.parent.parent?.type === "selectors") ||
    matchesParentTypePairs(node, [
      ["class_selector", "class_name"],
      ["id_selector", "id_name"],
    ]),
  scopeDeclarationNames: "all",
};
registerLanguage(SCSS_DEF);
