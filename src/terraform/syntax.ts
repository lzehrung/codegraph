import type { SyntaxNodeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import { toRange } from "../util/ast.js";

/**
 * Terraform declarations and references proven from HCL syntax.
 *
 * A Terraform module is a directory, so declarations here are keyed by kind, name, and (for
 * resources and data sources) type within that directory. References name their target through
 * a fixed address form: `var.<name>`, `local.<name>`, `module.<name>[.<output>]`,
 * `data.<type>.<name>`, and `<type>.<name>` for a managed resource. Module call arguments name an
 * input variable of the called module. Nothing here reads another file; `./resolution.ts` owns
 * every cross-file decision.
 */

export type TerraformDeclarationKind = "variable" | "local" | "output" | "module" | "resource" | "data";

export type TerraformDeclaration = {
  kind: TerraformDeclarationKind;
  /** Resource or data source type label, such as `aws_instance`. */
  type?: string;
  name: string;
  /** Range of the declared name: the label text or the `locals` attribute name. */
  range: Range;
  /** Literal `source` of a module call; absent when missing or not a plain string. */
  source?: string;
};

export type TerraformReferenceTarget =
  | { kind: "variable" | "local" | "module"; name: string }
  | { kind: "resource" | "data"; type: string; name: string }
  /** `module.<module>.<name>`: an output of the called module. */
  | { kind: "output"; module: string; name: string }
  /** An argument in `module "<module>" { <name> = ... }`: an input variable of the called module. */
  | { kind: "input"; module: string; name: string };

export type TerraformReferenceSite = {
  /** Range of the identifier that spells the target's name. */
  range: Range;
  target: TerraformReferenceTarget;
};

export type TerraformFileFacts = {
  declarations: TerraformDeclaration[];
  references: TerraformReferenceSite[];
};

/** Module block arguments that configure the call instead of passing an input variable. */
const MODULE_META_ARGUMENTS = new Set(["source", "version", "providers", "count", "for_each", "depends_on"]);

/**
 * Reference roots that are Terraform built-ins or iteration values. `ephemeral.<type>.<name>`
 * names an ephemeral resource, which is not indexed.
 */
const BUILT_IN_ROOTS = new Set(["path", "terraform", "self", "count", "each", "ephemeral"]);

/** An HCL identifier: a letter or `_`, then letters, digits, `_`, or `-` (`my-server`). */
export const TERRAFORM_IDENTIFIER_PATTERN = /^[_\p{ID_Start}][_\p{ID_Continue}-]*$/u;

function sameNode(left: SyntaxNodeLike | null | undefined, right: SyntaxNodeLike | null | undefined): boolean {
  return (
    !!left &&
    !!right &&
    left.type === right.type &&
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex
  );
}

function containsNode(ancestor: SyntaxNodeLike, node: SyntaxNodeLike): boolean {
  return node.startIndex >= ancestor.startIndex && node.endIndex <= ancestor.endIndex;
}

function blockTypeName(block: SyntaxNodeLike): string | undefined {
  const first = block.namedChildren[0];
  return first?.type === "identifier" ? first.text : undefined;
}

/** Labels between the block type and `{`. */
function blockLabels(block: SyntaxNodeLike): SyntaxNodeLike[] {
  const labels: SyntaxNodeLike[] = [];
  for (const child of block.namedChildren.slice(1)) {
    if (child.type === "block_start") break;
    labels.push(child);
  }
  return labels;
}

function blockBody(block: SyntaxNodeLike): SyntaxNodeLike | undefined {
  return block.namedChildren.find((child) => child.type === "body");
}

function isTopLevelBlock(block: SyntaxNodeLike): boolean {
  return block.parent?.type === "body" && block.parent.parent?.type === "config_file";
}

/** The text node of a quoted string with no interpolation, such as a block label. */
function literalStringText(stringLit: SyntaxNodeLike | undefined): SyntaxNodeLike | null {
  if (stringLit?.type !== "string_lit") return null;
  const parts = stringLit.namedChildren.filter(
    (child) => child.type !== "quoted_template_start" && child.type !== "quoted_template_end",
  );
  const text = parts.length === 1 ? parts[0] : undefined;
  return text?.type === "template_literal" ? text : null;
}

function attributeNameNode(attribute: SyntaxNodeLike): SyntaxNodeLike | undefined {
  const name = attribute.namedChildren[0];
  return name?.type === "identifier" ? name : undefined;
}

function attributeValue(attribute: SyntaxNodeLike): SyntaxNodeLike | undefined {
  return attribute.namedChildren.find((child) => child.type === "expression");
}

function bodyAttributes(block: SyntaxNodeLike): SyntaxNodeLike[] {
  return blockBody(block)?.namedChildren.filter((child) => child.type === "attribute") ?? [];
}

/** A plain string attribute value, such as a module `source`. */
function literalStringValue(attribute: SyntaxNodeLike): string | undefined {
  const value = attributeValue(attribute);
  if (value?.namedChildren.length !== 1) return undefined;
  const literal = value.namedChildren[0];
  if (literal?.type !== "literal_value" || literal.namedChildren.length !== 1) return undefined;
  return literalStringText(literal.namedChildren[0])?.text;
}

/** A bare identifier attribute value, such as a `dynamic` block `iterator`. */
function bareIdentifierValue(attribute: SyntaxNodeLike): string | undefined {
  const value = attributeValue(attribute);
  if (value?.namedChildren.length !== 1) return undefined;
  const variable = value.namedChildren[0];
  if (variable?.type !== "variable_expr") return undefined;
  const identifier = variable.namedChildren[0];
  return identifier?.type === "identifier" ? identifier.text : undefined;
}

/**
 * The Terraform declaration a name node declares, or null. Shared by symbol classification and
 * reference resolution so both read one declaration rule. Only top-level blocks with quoted,
 * uninterpolated labels declare names.
 */
export function terraformDeclarationForNameNode(
  node: SyntaxNodeLike,
): { kind: TerraformDeclarationKind; type?: string } | null {
  if (node.type === "identifier") {
    const attribute = node.parent;
    if (attribute?.type !== "attribute" || !sameNode(attributeNameNode(attribute), node)) return null;
    const block = attribute.parent?.parent;
    if (block?.type !== "block" || !isTopLevelBlock(block)) return null;
    if (blockTypeName(block) !== "locals" || blockLabels(block).length) return null;
    return { kind: "local" };
  }
  if (node.type !== "template_literal") return null;
  const label = node.parent;
  const block = label?.parent;
  if (!label || block?.type !== "block" || !isTopLevelBlock(block)) return null;
  if (!sameNode(literalStringText(label), node)) return null;
  const labels = blockLabels(block);
  const kind = blockTypeName(block);
  if ((kind === "variable" || kind === "output" || kind === "module") && labels.length === 1) return { kind };
  if ((kind === "resource" || kind === "data") && labels.length === 2 && sameNode(labels[1], label)) {
    const type = literalStringText(labels[0]);
    return type ? { kind, type: type.text } : null;
  }
  return null;
}

/** Symbol classification for `LanguageDefinition.classifyDefinition`. */
export function classifyTerraformDefinition(node: SyntaxNodeLike): string {
  const declaration = terraformDeclarationForNameNode(node);
  if (!declaration || declaration.kind === "local") return "variable";
  return declaration.kind;
}

function declarationNameNodes(block: SyntaxNodeLike): SyntaxNodeLike[] {
  if (blockTypeName(block) === "locals") {
    return bodyAttributes(block).flatMap((attribute) => {
      const name = attributeNameNode(attribute);
      return name ? [name] : [];
    });
  }
  const labels = blockLabels(block);
  const label = labels.at(-1);
  const text = literalStringText(label);
  return text ? [text] : [];
}

function collectDeclarations(root: SyntaxNodeLike, facts: TerraformFileFacts): void {
  const body = root.namedChildren.find((child) => child.type === "body");
  for (const block of body?.namedChildren ?? []) {
    if (block.type !== "block") continue;
    for (const nameNode of declarationNameNodes(block)) {
      const declaration = terraformDeclarationForNameNode(nameNode);
      if (!declaration) continue;
      const entry: TerraformDeclaration = {
        kind: declaration.kind,
        ...(declaration.type ? { type: declaration.type } : {}),
        name: nameNode.text,
        range: toRange(nameNode),
      };
      if (declaration.kind === "module") collectModuleCall(block, entry, facts);
      facts.declarations.push(entry);
    }
  }
}

function collectModuleCall(block: SyntaxNodeLike, declaration: TerraformDeclaration, facts: TerraformFileFacts): void {
  for (const attribute of bodyAttributes(block)) {
    const nameNode = attributeNameNode(attribute);
    if (!nameNode) continue;
    if (nameNode.text === "source") {
      const source = literalStringValue(attribute);
      if (source !== undefined) declaration.source = source;
      continue;
    }
    if (MODULE_META_ARGUMENTS.has(nameNode.text)) continue;
    facts.references.push({
      range: toRange(nameNode),
      target: { kind: "input", module: declaration.name, name: nameNode.text },
    });
  }
}

type TraversalStep = { kind: "attr"; name: SyntaxNodeLike } | { kind: "index" };

/** `get_attr` and index steps after the root; a splat or any other node ends the traversal. */
function traversalSteps(expression: SyntaxNodeLike, variable: SyntaxNodeLike): TraversalStep[] {
  const steps: TraversalStep[] = [];
  const children = expression.namedChildren;
  const start = children.findIndex((child) => sameNode(child, variable));
  for (const child of children.slice(start + 1)) {
    if (child.type === "get_attr") {
      const name = child.namedChildren[0];
      if (name?.type !== "identifier") break;
      steps.push({ kind: "attr", name });
    } else if (child.type === "index") {
      steps.push({ kind: "index" });
    } else {
      break;
    }
  }
  return steps;
}

function isObjectKey(expression: SyntaxNodeLike): boolean {
  const element = expression.parent;
  return element?.type === "object_elem" && sameNode(element.childForFieldName("key"), expression);
}

function dynamicIteratorName(dynamicBlock: SyntaxNodeLike): string | undefined {
  for (const attribute of bodyAttributes(dynamicBlock)) {
    if (attributeNameNode(attribute)?.text === "iterator") return bareIdentifierValue(attribute);
  }
  return literalStringText(blockLabels(dynamicBlock)[0])?.text;
}

/** True when `root` names a `for` iterator, template `for` iterator, or `dynamic` iterator in scope. */
function isIteratorInScope(variable: SyntaxNodeLike, root: string): boolean {
  for (let node = variable.parent; node; node = node.parent) {
    if (node.type === "for_tuple_expr" || node.type === "for_object_expr") {
      const intro = node.namedChildren.find((child) => child.type === "for_intro");
      if (
        intro &&
        !containsNode(intro, variable) &&
        intro.namedChildren.some((child) => child.type === "identifier" && child.text === root)
      ) {
        return true;
      }
    } else if (node.type === "template_for") {
      const start = node.namedChildren.find((child) => child.type === "template_for_start");
      if (
        start &&
        !containsNode(start, variable) &&
        start.namedChildren.some((child) => child.type === "identifier" && child.text === root)
      ) {
        return true;
      }
    } else if (node.type === "block" && blockTypeName(node) === "content") {
      const dynamicBlock = node.parent?.parent;
      if (
        dynamicBlock?.type === "block" &&
        blockTypeName(dynamicBlock) === "dynamic" &&
        dynamicIteratorName(dynamicBlock) === root
      ) {
        return true;
      }
    }
  }
  return false;
}

function firstAttribute(steps: readonly TraversalStep[], from = 0): SyntaxNodeLike | undefined {
  const step = steps[from];
  return step?.kind === "attr" ? step.name : undefined;
}

function collectReference(variable: SyntaxNodeLike, facts: TerraformFileFacts): void {
  const expression = variable.parent;
  if (expression?.type !== "expression" || isObjectKey(expression)) return;
  const rootNode = variable.namedChildren[0];
  if (rootNode?.type !== "identifier") return;
  const root = rootNode.text;
  if (isIteratorInScope(variable, root)) return;
  const steps = traversalSteps(expression, variable);
  const push = (name: SyntaxNodeLike, target: TerraformReferenceTarget): void => {
    facts.references.push({ range: toRange(name), target });
  };

  if (root === "var" || root === "local") {
    const name = firstAttribute(steps);
    if (name) push(name, { kind: root === "var" ? "variable" : "local", name: name.text });
    return;
  }
  if (root === "module") {
    const moduleName = firstAttribute(steps);
    if (!moduleName) return;
    push(moduleName, { kind: "module", name: moduleName.text });
    let next = 1;
    while (steps[next]?.kind === "index") next += 1;
    const output = firstAttribute(steps, next);
    if (output) push(output, { kind: "output", module: moduleName.text, name: output.text });
    return;
  }
  if (root === "data") {
    const type = firstAttribute(steps);
    const name = firstAttribute(steps, 1);
    if (type && name) push(name, { kind: "data", type: type.text, name: name.text });
    return;
  }
  if (BUILT_IN_ROOTS.has(root)) return;
  const name = firstAttribute(steps);
  if (name) push(name, { kind: "resource", type: root, name: name.text });
}

/** Extracts declarations and reference sites from one parsed Terraform file. */
export function extractTerraformFacts(root: SyntaxNodeLike): TerraformFileFacts {
  const facts: TerraformFileFacts = { declarations: [], references: [] };
  collectDeclarations(root, facts);
  const stack: SyntaxNodeLike[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "variable_expr") {
      collectReference(node, facts);
      continue;
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  facts.references.sort((left, right) => (left.range.start.index ?? 0) - (right.range.start.index ?? 0));
  return facts;
}
