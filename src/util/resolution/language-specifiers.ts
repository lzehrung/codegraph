import type { SpecifierTargetPolicy } from "./language-policy-types.js";
import { C_SPECIFIER_POLICY, CPP_SPECIFIER_POLICY } from "./c-family-specifiers.js";
import { CSHARP_SPECIFIER_POLICY, RUBY_SPECIFIER_POLICY } from "./namespace-specifiers.js";
import {
  GO_SPECIFIER_POLICY,
  JAVA_SPECIFIER_POLICY,
  KOTLIN_SPECIFIER_POLICY,
  PHP_SPECIFIER_POLICY,
  PYTHON_SPECIFIER_POLICY,
  RUST_SPECIFIER_POLICY,
  TERRAFORM_SPECIFIER_POLICY,
  ZIG_SPECIFIER_POLICY,
} from "./package-specifiers.js";

const NO_POLICY: SpecifierTargetPolicy = {};
const POLICIES: Readonly<Record<string, SpecifierTargetPolicy>> = {
  c: C_SPECIFIER_POLICY,
  cpp: CPP_SPECIFIER_POLICY,
  csharp: CSHARP_SPECIFIER_POLICY,
  go: GO_SPECIFIER_POLICY,
  java: JAVA_SPECIFIER_POLICY,
  kotlin: KOTLIN_SPECIFIER_POLICY,
  php: PHP_SPECIFIER_POLICY,
  python: PYTHON_SPECIFIER_POLICY,
  ruby: RUBY_SPECIFIER_POLICY,
  rust: RUST_SPECIFIER_POLICY,
  scss: { allowPartialResolution: true },
  terraform: TERRAFORM_SPECIFIER_POLICY,
  zig: ZIG_SPECIFIER_POLICY,
};

export function specifierTargetPolicyFor(languageId: string): SpecifierTargetPolicy {
  return POLICIES[languageId] ?? NO_POLICY;
}
