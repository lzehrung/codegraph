// Local ESLint rule: every child_process launch must pass an inline options object with
// `windowsHide`, otherwise Windows opens a visible console window for the child.

const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const LAUNCHERS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);

/** @param {import("estree").Node | null | undefined} node */
function moduleSpecifier(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

/** @param {import("estree").Node | null | undefined} node */
function isChildProcessLoad(node) {
  if (!node) return false;
  if (node.type === "AwaitExpression") return isChildProcessLoad(node.argument);
  if (node.type === "ImportExpression") return CHILD_PROCESS_MODULES.has(moduleSpecifier(node.source) ?? "");
  if (node.type !== "CallExpression") return false;
  if (node.callee.type !== "Identifier" || node.callee.name !== "require") return false;
  return CHILD_PROCESS_MODULES.has(moduleSpecifier(node.arguments[0]) ?? "");
}

/** @param {import("estree").Property | import("estree").SpreadElement} property */
function windowsHideProperty(property) {
  if (property.type !== "Property") return false;
  const { key } = property;
  if (property.computed) return false;
  const name = key.type === "Identifier" ? key.name : moduleSpecifier(key);
  return name === "windowsHide";
}

/** @type {import("eslint").Rule.RuleModule} */
export const requireWindowsHide = {
  meta: {
    type: "problem",
    docs: {
      description: "Require windowsHide in the inline options of every child_process launch",
    },
    schema: [],
    messages: {
      missingOptions:
        "{{name}}() must pass an inline options object containing windowsHide: true so Windows does not open a console window.",
      missingWindowsHide: "{{name}}() options must set windowsHide: true so Windows does not open a console window.",
      windowsHideFalse: "{{name}}() options must not set windowsHide to false.",
    },
  },
  create(context) {
    /** Local binding name -> child_process launcher name. */
    const launcherBindings = new Map();
    /** Local names bound to the whole child_process module. */
    const namespaceBindings = new Set();
    /** @type {{ node: import("estree").CallExpression; name: string }[]} */
    const launches = [];

    /** @param {import("estree").Node} node */
    function launcherName(node) {
      if (node.type === "Identifier") return launcherBindings.get(node.name) ?? null;
      if (node.type !== "MemberExpression" || node.computed) return null;
      if (node.object.type !== "Identifier" || !namespaceBindings.has(node.object.name)) return null;
      if (node.property.type !== "Identifier" || !LAUNCHERS.has(node.property.name)) return null;
      return node.property.name;
    }

    /** @param {import("estree").Node} callee */
    function isPromisify(callee) {
      if (callee.type === "Identifier") return callee.name === "promisify";
      return (
        callee.type === "MemberExpression" &&
        callee.property.type === "Identifier" &&
        callee.property.name === "promisify"
      );
    }

    return {
      ImportDeclaration(node) {
        if (!CHILD_PROCESS_MODULES.has(String(node.source.value))) return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") {
            namespaceBindings.add(specifier.local.name);
            continue;
          }
          const imported =
            specifier.imported.type === "Identifier" ? specifier.imported.name : String(specifier.imported.value);
          if (LAUNCHERS.has(imported)) launcherBindings.set(specifier.local.name, imported);
        }
      },
      VariableDeclarator(node) {
        const { id, init } = node;
        if (!init) return;
        if (isChildProcessLoad(init)) {
          if (id.type === "Identifier") namespaceBindings.add(id.name);
          if (id.type !== "ObjectPattern") return;
          for (const property of id.properties) {
            if (property.type !== "Property" || property.computed) continue;
            if (property.key.type !== "Identifier" || property.value.type !== "Identifier") continue;
            if (LAUNCHERS.has(property.key.name)) launcherBindings.set(property.value.name, property.key.name);
          }
          return;
        }
        // `const run = promisify(execFile)` keeps the launcher's argument shape.
        if (id.type !== "Identifier" || init.type !== "CallExpression" || !isPromisify(init.callee)) return;
        const wrapped = init.arguments[0];
        const name = wrapped && wrapped.type !== "SpreadElement" ? launcherName(wrapped) : null;
        if (name) launcherBindings.set(id.name, name);
      },
      CallExpression(node) {
        const name = launcherName(node.callee);
        if (name) launches.push({ node, name });
      },
      "Program:exit"() {
        for (const { node, name } of launches) {
          // The first argument is always the command or module; options follow the optional argv.
          const options = node.arguments.slice(1).find((argument) => argument.type === "ObjectExpression");
          if (!options) {
            context.report({ node, messageId: "missingOptions", data: { name } });
            continue;
          }
          const property = options.properties.find(windowsHideProperty);
          if (!property) {
            context.report({ node: options, messageId: "missingWindowsHide", data: { name } });
            continue;
          }
          const { value } = property;
          if (value.type === "Literal" && value.value === false) {
            context.report({ node: property, messageId: "windowsHideFalse", data: { name } });
          }
        }
      },
    };
  },
};

export default {
  rules: { "require-windows-hide": requireWindowsHide },
};
