import type { CallableIdentityPolicy } from "../callable-identity-policy-types.js";
import { cCallableIdentityPolicy, cppCallableIdentityPolicy } from "./c-family-index.js";
import { swiftCallableIdentityPolicy } from "./swift-index.js";
import { typescriptCallableIdentityPolicy } from "./typescript-index.js";

const NO_POLICY: CallableIdentityPolicy = {};
const POLICIES: Readonly<Record<string, CallableIdentityPolicy>> = {
  c: cCallableIdentityPolicy,
  cpp: cppCallableIdentityPolicy,
  ts: typescriptCallableIdentityPolicy,
  tsx: typescriptCallableIdentityPolicy,
  swift: swiftCallableIdentityPolicy,
};

export function callableIdentityPolicyFor(languageId: string): CallableIdentityPolicy {
  return POLICIES[languageId] ?? NO_POLICY;
}
