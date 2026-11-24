import { parseRustImportStatements } from "../../languages/import-statement-parsers.js";
import { rustSpecifierForParsedImport } from "../../indexer/imports/text-import-extractors.js";
import { pythonTypeCheckingContext } from "../../util/python-type-checking.js";
import { isRustCfgTestStatement } from "../../util/rust-test-modules.js";
import { cFamilyImportFormFromText, isRubyLoadForm } from "../../util/specifiers.js";
import { collectSqlEdgesForFile } from "../../sql/source-graph.js";
import { collectEmbeddedImportRanges } from "../../languages/embedded-imports.js";
import type {
  SpecifierCollectionHooks,
  SpecifierExtractionPolicy,
} from "../../util/resolution/language-policy-types.js";
import { appendUniqueSpecifiers, makeSeenSet } from "./collection-utils.js";
import { PHP_SPECIFIER_COLLECTION } from "./php-specifiers.js";
import { STYLESHEET_SPECIFIER_COLLECTION } from "./stylesheet-specifiers.js";
import { TYPESCRIPT_SPECIFIER_COLLECTION } from "./typescript-specifiers.js";

const ECMASCRIPT_COLLECTION: SpecifierCollectionHooks = {
  exportCondition: { pattern: /\brequire\s*\(/, condition: "require" },
};
const TYPESCRIPT_COLLECTION: SpecifierCollectionHooks = {
  ...ECMASCRIPT_COLLECTION,
  ...TYPESCRIPT_SPECIFIER_COLLECTION,
};
const INCLUDE_COLLECTION: SpecifierCollectionHooks = { includeForm: cFamilyImportFormFromText };
const NO_POLICY: SpecifierExtractionPolicy = {};
const STYLESHEET_POLICY: SpecifierExtractionPolicy = { collect: STYLESHEET_SPECIFIER_COLLECTION };

const POLICIES: Readonly<Record<string, SpecifierExtractionPolicy>> = {
  c: { collect: INCLUDE_COLLECTION },
  cpp: { collect: INCLUDE_COLLECTION },
  css: STYLESHEET_POLICY,
  less: STYLESHEET_POLICY,
  html: { collect: { importStatementRanges: collectEmbeddedImportRanges } },
  scss: STYLESHEET_POLICY,
  js: { collect: ECMASCRIPT_COLLECTION },
  ts: { collect: TYPESCRIPT_COLLECTION },
  tsx: { collect: TYPESCRIPT_COLLECTION },
  php: { collect: PHP_SPECIFIER_COLLECTION },
  python: {
    collect: {
      statementTypeOnlyAt: pythonTypeCheckingContext,
      statement(statement, _source, _file, _startIndex, output) {
        // The grammar has no named path node for this module, so @stmt owns the path.
        if (!/^\s*from\s+__future__\b/.test(statement)) return false;
        output.push({ spec: "__future__" });
        return true;
      },
    },
  },
  ruby: { collect: { loadForm: (method) => (isRubyLoadForm(method) ? method : undefined) } },
  rust: {
    collect: {
      statementNeedsStartIndex: true,
      statement(statement, source, _file, startIndex, output) {
        if (isRustCfgTestStatement(source, statement, startIndex)) return true;
        const parsed = parseRustImportStatements(statement);
        if (!parsed.length) return false;
        appendUniqueSpecifiers(
          output,
          parsed.map((entry) => rustSpecifierForParsedImport(entry, source, startIndex)),
          makeSeenSet(output),
        );
        return true;
      },
    },
  },
  sql: { collect: { fileEdges: collectSqlEdgesForFile, rawEdgeIdentity: true } },
};

export function specifierExtractionPolicyFor(languageId: string): SpecifierExtractionPolicy {
  return POLICIES[languageId] ?? NO_POLICY;
}
