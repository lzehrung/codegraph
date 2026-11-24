import { kotlinExtensionReceiverType } from "../../languages/kotlin-graph.js";
import type { GraphHooks } from "./types.js";

export const kotlinGraphHooks: GraphHooks = {
  memberVisibility: "not-exported",
  declarationShapes: {
    propertyAccessors: {
      declarationType: "property_declaration",
      receiverType: kotlinExtensionReceiverType,
      variableType: "variable_declaration",
      nameType: "identifier",
      accessorTypes: { getter: true, setter: true },
    },
  },
};
