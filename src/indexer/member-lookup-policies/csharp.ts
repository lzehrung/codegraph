/** C# additions to member navigation and to reference coverage. */
import {
  csharpNamedArgumentCall,
  csharpUnprovenReferenceCandidate,
  isCsharpExtendedPropertyPattern,
  isCsharpMemberDesignator,
} from "../../util/csharp-designators.js";
import {
  UNPROBEABLE_IDENTIFIER_BLOOM_TOKEN,
  hasUnprobeableIdentifierSpelling,
  normalizeCsharpIdentifier,
} from "../../util/identifiers.js";
import {
  AMBIGUOUS_CSHARP_ATTRIBUTE_REASON,
  UNPROVEN_CSHARP_MEMBER_DESIGNATOR_REASON,
} from "../ambiguous-resolution.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import type { ParsedFileContext } from "../parse-context.js";
import { SymbolKind, type SymbolDef } from "../types.js";
import type { MemberLookupPolicy } from "./types.js";
import { csharpRecordProperty } from "./csharp-record-property.js";
import { csharpInterfaceRenameCompanions } from "./csharp-rename.js";

/** Method and local-function names bound call candidates; constructors can be written through type aliases. */
function callableParameterName(definition: SymbolDef, context: ParsedFileContext): string | null {
  if (definition.kind !== SymbolKind.Variable) return null;
  const start = definition.range.start.index;
  const end = definition.range.end.index;
  if (start === undefined || end === undefined) return null;
  const node = context.tree.rootNode.descendantForIndex(start, end);
  const parameter = node.parent;
  if (parameter?.type !== "parameter" || parameter.parent?.type !== "parameter_list") return null;
  const callable = parameter.parent.parent;
  if (callable?.type === "constructor_declaration") return "";
  if (callable?.type !== "method_declaration" && callable?.type !== "local_function_statement") return null;
  const name = callable.childForFieldName("name");
  return name ? context.sup.normalizeIdentifier(name.text) : "";
}

/** Reject a file only when no named argument or designator can spell this parameter. */
function mayContainNamedArgument(source: string, rawName: string, callName?: string): boolean {
  if (!source.includes(":") && !source.includes("=")) return false;
  let complexName = false;
  if (callName && !source.includes(callName)) {
    complexName = hasUnprobeableIdentifierSpelling(source);
    if (!complexName) return false;
  }
  const name = normalizeCsharpIdentifier(rawName);
  if (!name) return true;
  for (let start = source.indexOf(name); start !== -1; start = source.indexOf(name, start + 1)) {
    let position = start + name.length;
    while (position < source.length) {
      const character = source.charCodeAt(position);
      if (character === 58 || character === 61) return true;
      if (character === 32 || (character >= 9 && character <= 13)) {
        position += 1;
        continue;
      }
      // Trivia, directives, and non-ASCII text may separate a label from its separator.
      if (character === 47 || character === 35 || character > 127) return true;
      break;
    }
  }
  return complexName || hasUnprobeableIdentifierSpelling(source);
}

/** Unsupported member syntax and unproved positional properties must not make a rename look complete. */
function unprovenMemberReference(
  node: SyntaxNodeLike,
  reason: string | undefined,
  definitionName: SyntaxNodeLike,
): boolean {
  if (reason === AMBIGUOUS_CSHARP_ATTRIBUTE_REASON) return true;
  if (node.parent?.type === "member_binding_expression" || isCsharpExtendedPropertyPattern(node)) return true;
  const parameterList = definitionName.parent?.parent;
  if (parameterList?.type !== "parameter_list" || parameterList.parent?.type !== "record_declaration") return false;
  return node.parent?.type === "member_access_expression" || isCsharpMemberDesignator(node);
}

export const csharpMemberLookupPolicy: MemberLookupPolicy = {
  declaredReceiverUsesNameLookup: true,
  membersBeforeFileExports: true,
  implicitMember: csharpRecordProperty,
  renameCompanions: csharpInterfaceRenameCompanions,
  unprovenReferenceCandidate: csharpUnprovenReferenceCandidate,
  isStaticDeclaration: (node) =>
    node.type === "field_declaration" &&
    node.namedChildren.some((child) => child.type === "modifier" && child.text === "const"),
  parameterNamedAtCall: callableParameterName,
  parameterReferenceScanFilter: {
    mayContain: mayContainNamedArgument,
    includes: isCsharpMemberDesignator,
    unprobeableNameMarker: UNPROBEABLE_IDENTIFIER_BLOOM_TOKEN,
    unproven: (node, reason) => reason === UNPROVEN_CSHARP_MEMBER_DESIGNATOR_REASON && !!csharpNamedArgumentCall(node),
  },
  unprovenReference: unprovenMemberReference,
};
