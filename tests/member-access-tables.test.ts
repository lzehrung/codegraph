import { describe, expect, it } from "vitest";
import { getNativeSingleQueryExecution } from "../src/native/execution.js";
import { getNativeTreeSitterSupportedLanguageIds } from "../src/native/runtime.js";
import { LANGUAGE_SUPPORTS, supportById, type LanguageSupport } from "../src/languages.js";
import type { SyntaxNodeLike } from "../src/languages/types.js";
import { isMemberAccessNode } from "../src/util/member-access.js";
import {
  MEMBER_ACCESS_ROWS,
  receiverKeywordLanguageIds,
  type MemberAccessRow,
} from "../src/util/member-access-tables.js";

/**
 * `src/util/member-access-tables.ts` holds every per-language member-access shape and receiver
 * keyword list the member-access walker and the receiver-call pass used to inline. These cases
 * re-derive the table's claims: whether a grammar has a node type is decided by compiling a query
 * against that language's own pinned grammar, so a row that drifts from the grammar fails here,
 * and an omission must be named with a reason or the coverage case fails.
 */

const NATIVE_LANGUAGE_IDS = new Set(getNativeTreeSitterSupportedLanguageIds("on"));

function grammarQueryCompiles(support: LanguageSupport, query: string): boolean {
  const execution = getNativeSingleQueryExecution("", support, query, "on");
  if (execution.matches) return true;
  if (execution.fallbackReason === "queryFailure" || execution.fallbackReason === "unsupportedLanguage") {
    return false;
  }
  throw new Error(`${support.id}: native grammar probe failed (${execution.fallbackReason}: ${execution.error ?? ""})`);
}

let probeNodeId = 0;

function probeNode(type: string): SyntaxNodeLike {
  return {
    id: (probeNodeId += 1),
    type,
    text: type,
    startIndex: 0,
    endIndex: 0,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: 0 },
    parent: null,
    namedChildren: [],
    child: () => null,
    childForFieldName: () => null,
  };
}

/** Node-type fields a row may declare. The grammar case below probes every one of them. */
function declaredNodeTypeLists(row: MemberAccessRow): Array<{ field: string; types: readonly string[] }> {
  const lists: Array<{ field: string; types: readonly string[] }> = [];
  if (row.memberExpressionType) lists.push({ field: "memberExpressionType", types: [row.memberExpressionType] });
  if (row.extraTraversalTypes) lists.push({ field: "extraTraversalTypes", types: row.extraTraversalTypes });
  if (row.extraMemberAccessTypes) lists.push({ field: "extraMemberAccessTypes", types: row.extraMemberAccessTypes });
  if (row.baseListNodeTypes) lists.push({ field: "baseListNodeTypes", types: row.baseListNodeTypes });
  const shapes = row.memberAccessShapes ?? [];
  for (const [index, shape] of shapes.entries()) {
    if (shape.nodeTypes) lists.push({ field: `memberAccessShapes[${index}] nodeTypes`, types: shape.nodeTypes });
  }
  return lists;
}

/** Capability fields a row may declare. An omission row must declare none of them. */
function declaredCapabilityFields(row: MemberAccessRow): string[] {
  const fields: string[] = [];
  if (row.memberExpressionType) fields.push("memberExpressionType");
  if (row.extraTraversalTypes) fields.push("extraTraversalTypes");
  if (row.extraMemberAccessTypes) fields.push("extraMemberAccessTypes");
  if (row.memberAccessShapes) fields.push("memberAccessShapes");
  if (row.navigationFallbackLastChild) fields.push("navigationFallbackLastChild");
  if (row.receiverKeywords) fields.push("receiverKeywords");
  if (row.memberAccessOmittedReason) fields.push("memberAccessOmittedReason");
  if (row.receiverKeywordsOmittedReason) fields.push("receiverKeywordsOmittedReason");
  return fields;
}

describe("member access tables", () => {
  it("declares a row for every registered language and nothing else", () => {
    const registeredIds = LANGUAGE_SUPPORTS.map((support) => support.id).sort();
    expect(NATIVE_LANGUAGE_IDS.size).toBeGreaterThan(0);
    expect(Object.keys(MEMBER_ACCESS_ROWS).sort()).toEqual(registeredIds);
  });

  it("keeps omission rows reason-only", () => {
    for (const [languageId, row] of Object.entries(MEMBER_ACCESS_ROWS)) {
      if (row.omittedReason === undefined) continue;
      expect(row.omittedReason.length, `${languageId} omission reason must be non-empty`).toBeGreaterThan(0);
      expect(
        declaredCapabilityFields(row),
        `${languageId} declares capability data despite its omission reason`,
      ).toEqual([]);
    }
  });

  it("requires a reason for every omitted capability", () => {
    for (const [languageId, row] of Object.entries(MEMBER_ACCESS_ROWS)) {
      if (row.omittedReason !== undefined) continue;
      if (row.memberAccessShapes === undefined) {
        expect(
          row.memberAccessOmittedReason,
          `${languageId} declares no member-access shapes and no reason`,
        ).toBeTruthy();
      } else {
        expect(
          row.memberAccessOmittedReason,
          `${languageId} declares shapes and also an omission reason`,
        ).toBeUndefined();
      }
      if (row.receiverKeywords === undefined) {
        expect(
          row.receiverKeywordsOmittedReason,
          `${languageId} declares no receiver keywords and no reason`,
        ).toBeTruthy();
      } else {
        expect(
          row.receiverKeywordsOmittedReason,
          `${languageId} declares receiver keywords and also an omission reason`,
        ).toBeUndefined();
      }
    }
  });

  it("declares only node types the pinned grammar produces", () => {
    for (const [languageId, row] of Object.entries(MEMBER_ACCESS_ROWS)) {
      if (row.omittedReason !== undefined) continue;
      const support = supportById(languageId)!;
      if (!NATIVE_LANGUAGE_IDS.has(languageId)) {
        // A capability row without a loadable pinned grammar is a parser-availability gap, not a
        // capability omission: report it distinctly instead of probing an absent grammar.
        throw new Error(`${languageId} declares member-access data but its pinned grammar cannot be loaded`);
      }
      for (const { field, types } of declaredNodeTypeLists(row)) {
        for (const nodeType of types) {
          expect(
            grammarQueryCompiles(support, `(${nodeType}) @x`),
            `${languageId}.${field} declares ${nodeType}, which its grammar does not have`,
          ).toBe(true);
        }
      }
    }
  });

  it("keys every shape to a node type the language treats as member access", () => {
    for (const [languageId, row] of Object.entries(MEMBER_ACCESS_ROWS)) {
      if (row.omittedReason !== undefined) continue;
      const support = supportById(languageId)!;
      for (const [index, shape] of (row.memberAccessShapes ?? []).entries()) {
        for (const nodeType of shape.nodeTypes ?? []) {
          expect(
            isMemberAccessNode(support, probeNode(nodeType)),
            `${languageId}: memberAccessShapes[${index}] keys ${nodeType}, which isMemberAccessNode rejects`,
          ).toBe(true);
        }
      }
    }
  });

  it("keeps catch-all shapes last so a keyed shape cannot be shadowed", () => {
    for (const [languageId, row] of Object.entries(MEMBER_ACCESS_ROWS)) {
      const shapes = row.memberAccessShapes ?? [];
      shapes.forEach((shape, index) => {
        if (shape.nodeTypes !== undefined) return;
        expect(index, `${languageId}: catch-all memberAccessShapes[${index}] must be the row's last shape`).toBe(
          shapes.length - 1,
        );
      });
    }
  });

  it("names only registered languages in the receiver keyword list", () => {
    const registeredIds = new Set(LANGUAGE_SUPPORTS.map((support) => support.id));
    for (const languageId of receiverKeywordLanguageIds) {
      expect(registeredIds.has(languageId), `receiver keywords name unregistered language id ${languageId}`).toBe(true);
    }
  });
});
