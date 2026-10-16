import type { BlockDefinition, LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { classifyTerraformDefinition, terraformDeclarationForNameNode } from "../../terraform/syntax.js";

/** A quoted block label with no interpolation, capturing its text as `capture`. */
function literalLabel(capture?: string): string {
  const name = capture ? ` @${capture}` : "";
  return `(string_lit . (quoted_template_start) . (template_literal)${name} . (quoted_template_end) .)`;
}

/** An anchored step between block header parts; a comment may sit between them. */
const HEADER_GAP = ". (comment)* .";

/** A chunk block for top-level block keywords that take `labels` labels; the last label names it. */
function labeledChunkBlock(keywords: readonly string[], labels: 1 | 2, captureId: string): BlockDefinition {
  const keywordList = keywords.map((keyword) => `"${keyword}"`).join(" ");
  const leading = labels === 2 ? ` ${HEADER_GAP} (string_lit)` : "";
  return {
    type: "block",
    nameQuery: `. (identifier) @kw (#any-of? @kw ${keywordList})${leading} ${HEADER_GAP} (string_lit (template_literal) @chunk.name) ${HEADER_GAP} (block_start)`,
    captureId,
  };
}

/** A chunk block for an unlabeled top-level block keyword; the keyword names it. */
function unlabeledChunkBlock(keywords: readonly string[], captureId: string): BlockDefinition {
  const keywordList = keywords.map((keyword) => `"${keyword}"`).join(" ");
  return {
    type: "block",
    nameQuery: `. (identifier) @chunk.name (#any-of? @chunk.name ${keywordList}) ${HEADER_GAP} (block_start)`,
    captureId,
  };
}

const ONE_LABEL_DECLARATION = `(config_file (body (block . (identifier) @kind (#any-of? @kind "variable" "output" "module") ${HEADER_GAP} ${literalLabel("name")} ${HEADER_GAP} (block_start))))`;
const TWO_LABEL_DECLARATION = `(config_file (body (block . (identifier) @kind (#any-of? @kind "resource" "data") ${HEADER_GAP} ${literalLabel()} ${HEADER_GAP} ${literalLabel("name")} ${HEADER_GAP} (block_start))))`;
const LOCALS_DECLARATION = `(config_file (body (block . (identifier) @kind (#eq? @kind "locals") ${HEADER_GAP} (block_start) (body (attribute . (identifier) @name)))))`;

/**
 * Terraform (HCL) configuration. Symbols are top-level `variable`, `output`, `module`, `resource`,
 * and `data` blocks and `locals` attributes, named by their quoted label or attribute name. Inputs
 * (`variable`) and `output` values are a module's public interface. References and module calls
 * resolve in `src/terraform/`, not through generic imports or member access.
 */
export const TERRAFORM_DEF: LanguageDefinition = {
  id: "terraform",
  extensions: [".tf"],
  usesQueryDrivenLocals: true,
  structure: {
    blocks: [
      labeledChunkBlock(["resource"], 2, "resource"),
      labeledChunkBlock(["data"], 2, "data"),
      labeledChunkBlock(["module"], 1, "module"),
      labeledChunkBlock(["variable"], 1, "variable"),
      labeledChunkBlock(["output"], 1, "output"),
      unlabeledChunkBlock(["locals"], "locals"),
      labeledChunkBlock(["provider", "check"], 1, "block"),
      labeledChunkBlock(["ephemeral"], 2, "block"),
      unlabeledChunkBlock(["terraform", "moved", "import", "removed"], "block"),
    ],
    splitPoints: [],
    comments: ["comment"],
  },
  graph: {
    // A module call depends on its local `source` directory; remote sources stay external.
    imports: `
      (config_file (body (block . (identifier) @kw (#eq? @kw "module")
        (body (attribute . (identifier) @attr (#eq? @attr "source")
          . (expression . (literal_value . ${literalLabel("from")} .) .)))) @stmt))
    `,
    exports: `
      (config_file (body (block . (identifier) @kind (#any-of? @kind "variable" "output") ${HEADER_GAP} ${literalLabel("name")} ${HEADER_GAP} (block_start))))
    `,
    locals: `
      ${ONE_LABEL_DECLARATION}
      ${TWO_LABEL_DECLARATION}
      ${LOCALS_DECLARATION}
    `,
    // Module calls bind no local names; `module.<name>` resolves in src/terraform/.
    importBindings: "",
  },
  nodeTypes: {
    identifier: ["identifier"],
  },
  // Terraform references resolve in src/terraform/, so generic cross-module and member passes skip it.
  supportsCrossModuleSymbols: false,
  classifyDefinition: classifyTerraformDefinition,
  isDeclarationName: (node) => terraformDeclarationForNameNode(node) !== null,
};

registerLanguage(TERRAFORM_DEF);
