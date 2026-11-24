import { normalizeKotlinIdentifier } from "../../util/identifiers.js";
import { kotlinExtensionReceiverType } from "../../languages/kotlin-graph.js";
import type { ImportNameHooks, ReferenceHooks } from "../name-resolution-types.js";

export const javaReferenceHooks: ReferenceHooks = { candidateName: normalizeKotlinIdentifier };

export const kotlinReferenceHooks: ReferenceHooks = {
  candidateName: normalizeKotlinIdentifier,
  unprobeableNameScan: "always",
  callableVerification: "binding-collisions",
  extensionDeclaration: { receiverType: kotlinExtensionReceiverType, wrapperType: "variable_declaration" },
};

export const kotlinGraphImportHooks: ImportNameHooks = { aliasKey: normalizeKotlinIdentifier };
