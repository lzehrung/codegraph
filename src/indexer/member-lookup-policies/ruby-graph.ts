import type { GraphHooks } from "./types.js";

export const rubyGraphHooks: GraphHooks = {
  declarationShapes: {
    assignedFactoryType: {
      assignmentType: "assignment",
      targetType: "constant",
      callType: "call",
      receiverName: "Struct",
      methodName: "new",
    },
  },
};
