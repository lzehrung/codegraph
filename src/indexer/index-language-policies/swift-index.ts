import { swiftExtensionOwnerType } from "../../util/swift-tree.js";
import type { DeclarationHooks } from "../language-hook-types.js";

export const swiftDeclarations: DeclarationHooks = { extensionOwner: swiftExtensionOwnerType };
