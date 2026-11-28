import { normalizeCsharpIdentifier } from "../../util/identifiers.js";
import type { ImportNameHooks, ReferenceHooks } from "../name-resolution-types.js";

export const csharpReferenceHooks: ReferenceHooks = {
  unitPeerOptions: { csharpQualifiedName: true },
  namespaceBindingScope: "lexical-alias",
  namespaceImportDirectories: true,
  globalImports: true,
};

export const csharpGraphImportHooks: ImportNameHooks = { aliasKey: normalizeCsharpIdentifier };
