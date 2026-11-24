import type { IdentifierValidation } from "../types.js";

export const ECMASCRIPT_IDENTIFIER_VALIDATION: IdentifierValidation = {
  pattern: /^[$_\p{ID_Start}](?:[$_\p{ID_Continue}]|\u200c|\u200d)*$/u,
  privatePrefix: "#",
  reservedPrivateNames: { "#constructor": true },
};
