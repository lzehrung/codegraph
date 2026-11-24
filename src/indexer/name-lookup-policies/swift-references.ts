import { normalizeSwiftIdentifier } from "../../util/identifiers.js";
import type { ImportNameHooks, ReferenceHooks } from "../name-resolution-types.js";

export const swiftReferenceHooks: ReferenceHooks = { unprobeableNameScan: "non-token" };
export const swiftGraphImportHooks: ImportNameHooks = { aliasKey: normalizeSwiftIdentifier };
