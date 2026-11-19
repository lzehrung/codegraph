/**
 * PHP additions to member lookup and reference collection. This module imports no navigation module: those import the
 * policy registry.
 */
import { AMBIGUOUS_PHP_CONSTANT_REASON } from "../ambiguous-resolution.js";
import type { MemberLookupPolicy } from "./types.js";
import { foldPhpIdentifierCase } from "../../util/identifiers.js";

export const phpMemberLookupPolicy: MemberLookupPolicy = {
  // PHP method names fold case, so a method named like its class or trait (`$this->deep()` in `class Deep`) would
  // otherwise match that declaration's own name.
  excludesContainerNameFromMembers: true,
  memberNameKey: foldPhpIdentifierCase,
  // Any PHP file can read a project constant without an import, so a read that several constants compete for may name
  // the one being searched whether or not the file requires it.
  unprovenReference: (_node, reason) => reason === AMBIGUOUS_PHP_CONSTANT_REASON,
};
