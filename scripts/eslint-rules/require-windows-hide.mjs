// Local ESLint rule: every child_process launch must pass an inline options object that sets
// `windowsHide: true`, otherwise Windows opens a visible console window for the child.
//
// Launchers are found through ESLint scope analysis, so a parameter or local that shadows an
// imported name is not a launch, while aliases (`const run = spawn`), defaulted parameters
// (`{ spawnSyncImpl = spawnSync }`), `promisify(...)` wrappers, and namespace members are.
// `promisify` is resolved the same way, through its node:util binding, not by spelling.

const MODULES = new Map([
  ["child_process", "child_process"],
  ["node:child_process", "child_process"],
  ["util", "util"],
  ["node:util", "util"],
]);
const LAUNCHERS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);
const NAMESPACES = {
  child_process: Object.freeze({ kind: "namespace", module: "child_process" }),
  util: Object.freeze({ kind: "namespace", module: "util" }),
};
const PROMISIFY = Object.freeze({ kind: "promisify" });

/**
 * What `name` exported by `module` is: a child_process launcher, util.promisify, or neither.
 * @param {"child_process" | "util"} module
 * @param {string | null | undefined} name
 */
function exportOf(module, name) {
  if (!name) return null;
  if (module === "util") return name === "promisify" ? PROMISIFY : null;
  return LAUNCHERS.has(name) ? { kind: "launcher", name } : null;
}

/** @param {import("estree").Node | null | undefined} node */
function stringLiteral(node) {
  if (node && node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

/** @param {import("estree").Node | null | undefined} node */
function moduleNamespace(node) {
  const module = MODULES.get(stringLiteral(node) ?? "");
  return module ? NAMESPACES[module] : null;
}

const TYPE_ONLY_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);

/**
 * Strips TypeScript type-only wrappers (`x as T`, `x satisfies T`, `x!`, `<T>x`); parentheses are not in the AST.
 * @template {import("estree").Node | null | undefined} T
 * @param {T} node
 * @returns {T}
 */
function unwrapTypeOnly(node) {
  let current = node;
  while (current && TYPE_ONLY_WRAPPERS.has(current.type)) current = current.expression;
  return current;
}

/** Any non-computed property named windowsHide, whatever its kind: accessors and methods count. */
function isWindowsHideProperty(property) {
  if (property.type !== "Property" || property.computed) return false;
  const { key } = property;
  const name = key.type === "Identifier" ? key.name : stringLiteral(key);
  return name === "windowsHide";
}

/** @type {import("eslint").Rule.RuleModule} */
export const requireWindowsHide = {
  meta: {
    type: "problem",
    docs: {
      description: "Require a literal windowsHide: true in the inline options of every child_process launch",
    },
    schema: [],
    messages: {
      missingOptions:
        "{{name}}() must pass an inline options object containing windowsHide: true so Windows does not open a console window.",
      missingWindowsHide: "{{name}}() options must set windowsHide: true so Windows does not open a console window.",
      windowsHideNotTrue: "{{name}}() options must set windowsHide to the literal true.",
      windowsHideOverridable:
        "{{name}}() options must not spread or compute properties after windowsHide, which could override it.",
    },
  },
  create(context) {
    const { sourceCode } = context;
    /** Variable -> classification; null while being computed or when unrelated to child_process. */
    const classified = new Map();

    /** @param {import("estree").Identifier} identifier */
    function resolveVariable(identifier) {
      for (let scope = sourceCode.getScope(identifier); scope; scope = scope.upper) {
        const variable = scope.set.get(identifier.name);
        if (variable) return variable;
      }
      return null;
    }

    /**
     * @param {import("estree").Node | null | undefined} node
     * @returns {{ kind: "namespace"; module: "child_process" | "util" } | { kind: "launcher"; name: string } | { kind: "promisify" } | null}
     */
    function classifyExpression(rawNode) {
      const node = unwrapTypeOnly(rawNode);
      if (!node) return null;
      switch (node.type) {
        case "Identifier": {
          const variable = resolveVariable(node);
          return variable ? classifyVariable(variable) : null;
        }
        case "AwaitExpression":
          return classifyExpression(node.argument);
        case "ImportExpression":
          return moduleNamespace(node.source);
        case "LogicalExpression":
          return classifyExpression(node.left) ?? classifyExpression(node.right);
        case "ConditionalExpression":
          return classifyExpression(node.consequent) ?? classifyExpression(node.alternate);
        case "MemberExpression": {
          const namespace = classifyExpression(node.object);
          if (namespace?.kind !== "namespace") return null;
          return exportOf(namespace.module, node.computed ? stringLiteral(node.property) : node.property.name);
        }
        case "CallExpression": {
          const { callee } = node;
          if (callee.type === "Identifier" && callee.name === "require") {
            return moduleNamespace(node.arguments[0]);
          }
          if (classifyExpression(callee)?.kind !== "promisify") return null;
          const wrapped = classifyExpression(node.arguments[0]);
          return wrapped?.kind === "launcher" ? wrapped : null;
        }
        default:
          return null;
      }
    }

    /** @param {import("eslint").Scope.Variable} variable */
    function classifyVariable(variable) {
      if (classified.has(variable)) return classified.get(variable);
      classified.set(variable, null);
      let result = null;
      for (const definition of variable.defs) {
        result = classifyDefinition(definition);
        if (result) break;
      }
      classified.set(variable, result);
      return result;
    }

    /** @param {import("eslint").Scope.Definition} definition */
    function classifyDefinition(definition) {
      if (definition.type === "ImportBinding") {
        const declaration = definition.parent;
        const namespace = declaration && moduleNamespace(declaration.source);
        if (!namespace) return null;
        const specifier = definition.node;
        if (specifier.type !== "ImportSpecifier") return namespace;
        const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
        return exportOf(namespace.module, imported);
      }
      if (definition.type !== "Variable" && definition.type !== "Parameter") return null;
      let binding = definition.name;
      const defaulted = binding.parent;
      if (defaulted.type === "AssignmentPattern" && defaulted.left === binding) {
        const fromDefault = classifyExpression(defaulted.right);
        if (fromDefault) return fromDefault;
        binding = defaulted;
      }
      const owner = binding.parent;
      if (owner.type === "VariableDeclarator" && owner.id === binding) return classifyExpression(owner.init);
      // `const { spawn: run } = require("node:child_process")`.
      if (owner.type !== "Property" || owner.value !== binding || owner.computed) return null;
      const pattern = owner.parent;
      const declarator = pattern.parent;
      if (pattern.type !== "ObjectPattern" || declarator.type !== "VariableDeclarator" || declarator.id !== pattern) {
        return null;
      }
      const namespace = classifyExpression(declarator.init);
      if (namespace?.kind !== "namespace") return null;
      return exportOf(namespace.module, owner.key.type === "Identifier" ? owner.key.name : stringLiteral(owner.key));
    }

    return {
      CallExpression(node) {
        const launcher = classifyExpression(node.callee);
        if (launcher?.kind !== "launcher") return;
        const data = { name: launcher.name };
        // The first argument is the command or module; options follow the optional argv.
        const options = node.arguments
          .slice(1)
          .map(unwrapTypeOnly)
          .find((argument) => argument.type === "ObjectExpression");
        if (!options) {
          context.report({ node, messageId: "missingOptions", data });
          return;
        }
        const index = options.properties.findLastIndex(isWindowsHideProperty);
        if (index < 0) {
          context.report({ node: options, messageId: "missingWindowsHide", data });
          return;
        }
        const property = options.properties[index];
        const value = unwrapTypeOnly(property.value);
        const isPlainProperty = property.kind === "init" && !property.method;
        if (!isPlainProperty || value.type !== "Literal" || value.value !== true) {
          context.report({ node: property, messageId: "windowsHideNotTrue", data });
          return;
        }
        // A later spread or computed key may carry its own windowsHide and override the literal;
        // a later same-named accessor or method is already the last windowsHide property above.
        const later = options.properties
          .slice(index + 1)
          .find((entry) => entry.type === "SpreadElement" || entry.computed);
        if (later) context.report({ node: later, messageId: "windowsHideOverridable", data });
      },
    };
  },
};

export default {
  rules: { "require-windows-hide": requireWindowsHide },
};
