import type { ImpactDefinitionShapes, IdentifierValidation } from "../types.js";
import { SCSS_IDENTIFIER_PATTERN } from "../../scss/syntax.js";

export const STYLESHEET_IMPACT_DEFINITIONS: ImpactDefinitionShapes = {
  names: [
    { nodeType: "class_name", parentType: "class_selector" },
    { nodeType: "id_name", parentType: "id_selector" },
  ],
};

export const SCSS_IMPACT_DEFINITIONS: ImpactDefinitionShapes = {
  names: [
    ...STYLESHEET_IMPACT_DEFINITIONS.names,
    { nodeType: "variable", parentType: "variable_declaration" },
    { nodeType: "name", parentType: "mixin_statement" },
    { nodeType: "name", parentType: "function_statement" },
  ],
};

export const SCSS_IDENTIFIER_VALIDATION: IdentifierValidation = { pattern: SCSS_IDENTIFIER_PATTERN };
