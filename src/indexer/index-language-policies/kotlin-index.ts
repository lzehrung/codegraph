import { normalizeKotlinQualifiedName } from "../../util/identifiers.js";
import type { PublicSurfaceHooks } from "../public-surface-types.js";

export const kotlinPublicSurface: PublicSurfaceHooks = { normalizeImportName: normalizeKotlinQualifiedName };
