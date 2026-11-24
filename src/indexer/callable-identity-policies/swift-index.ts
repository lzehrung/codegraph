import { swiftCallableParameters } from "../../util/swift-tree.js";
import type { CallableIdentityPolicy } from "../callable-identity-policy-types.js";

export const swiftCallableIdentityPolicy: CallableIdentityPolicy = {
  declarationParameters: swiftCallableParameters,
};
