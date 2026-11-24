#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const familyMap = {
  isJsTsLanguage: ["js", "ts", "tsx"],
  isJvmLanguage: ["java", "kotlin"],
  isGraphOnlyLanguage: ["markdown", "mdx", "astro", "hbs", "rst", "adoc"],
  graphOnlyLanguageSupportsImportAliases: ["mdx", "astro"],
};
const namedSets = {
  DECLARATION_RESOLVED_IMPORT_LANGUAGES: ["cpp", "csharp", "java", "kotlin", "php"],
  DOCSTRING_CAPTURE_LANGUAGES: ["ts", "tsx", "js", "go", "java", "csharp", "kotlin", "rust", "zig", "scss"],
  SEPARATE_MEMBER_SCOPES: ["js", "ts", "tsx", "ruby", "swift", "kotlin"],
  HTML_LIKE_LANGUAGE_IDS: ["html", "vue", "svelte"],
  ANGULAR_JS_LANGUAGE_IDS: ["js", "ts", "tsx"],
  CALLABLE_ARITY_LANGUAGE_ID_DECLARATIONS: [
    "c",
    "cpp",
    "csharp",
    "go",
    "java",
    "js",
    "kotlin",
    "php",
    "python",
    "ruby",
    "rust",
    "swift",
    "ts",
    "tsx",
    "zig",
  ],
  GRAPH_ONLY_LANGUAGE_IDS: ["markdown", "mdx", "astro", "hbs", "rst", "adoc"],
  GRAPH_ONLY_ALIAS_LANGUAGE_IDS: ["mdx", "astro"],
  STYLESHEET_LANGUAGE_IDS: ["css", "scss", "less"],
  jsFamilyLanguageIds: ["js", "ts", "tsx"],
};
const dynamicSets = new Set([
  "src/cli/chunk.ts::supportedChunkLanguageIds",
  "src/impact/call-compatibility/providers/index.ts::callCompatibilityLanguageIds",
  "src/impact/call-compatibility/providers/index.ts::provider.languageIds",
  "src/impact/call-compatibility.ts::diagnostics.unsupportedLanguages",
  "src/indexer/build-index.ts::unknownDeclarationHistory",
  "src/native/execution.ts::state.supportedLanguageIds",
  "src/native/runtime.ts::state.supportedLanguageIds",
  "src/worker/native-extract-worker.ts::supportedIds",
]);
const boundarySites = new Set([
  'src/bootstrap/tree-sitter-languages.ts::<module>::lang.id === "vue"',
  'src/bootstrap/tree-sitter-languages.ts::<module>::lang.id === "svelte"',
  'src/bootstrap/tree-sitter-languages.ts::<module>::lang.id === "markdown"',
  'src/bootstrap/tree-sitter-languages.ts::<module>::lang.id === "mdx"',
  'src/bootstrap/tree-sitter-languages.ts::<module>::lang.id === "astro"',
  'src/bootstrap/tree-sitter-languages.ts::<module>::lang.id === "hbs"',
  'src/bootstrap/tree-sitter-languages.ts::<module>::lang.id === "rst"',
  'src/bootstrap/tree-sitter-languages.ts::<module>::lang.id === "adoc"',
  'src/chunking/chunk-sfc.ts::chunkSFCFile::framework === "svelte"',
  'src/chunking/chunk-sfc.ts::selectLanguageKey::langId === "ts"',
  'src/chunking/chunk-sfc.ts::selectLanguageKey::langId === "tsx"',
  'src/cli/chunk.ts::handleChunkCommand::languageId === "vue"',
  'src/cli/chunk.ts::handleChunkCommand::languageId === "svelte"',
  'src/document-links/check.ts::Array.from(new Set(markdownFileCandidates)) .filter((file) => isFilePathWithinRo callback::supportForFileWithoutHeaderSample(file)?.id === "markdown"',
  'src/document-links/check.ts::checkMarkdownLinksInFiles::supportForFileWithoutHeaderSample(resolvedTarget)?.id !== "markdown"',
  'src/drift/languages.ts::driftLanguageId::id === "ts"',
  'src/indexer/build-cache/module-cache.ts::hasValidImportBindingRanges::binding.jvmPackageLanguageId === "java"',
  'src/indexer/build-cache/module-cache.ts::hasValidImportBindingRanges::binding.jvmPackageLanguageId === "kotlin"',
  'src/indexer/build-cache/project-snapshot.ts::isImportBinding::binding.jvmPackageLanguageId !== "java"',
  'src/indexer/build-cache/project-snapshot.ts::isImportBinding::binding.jvmPackageLanguageId !== "kotlin"',
  'src/languages/file-prep.ts::prepareSFCSourceInput::framework === "svelte"',
  'src/languages/sfc.ts::inferScriptLanguage::lang === "ts"',
  'src/languages/sfc.ts::inferScriptLanguage::lang === "tsx"',
  'src/languages/sfc.ts::styleLanguageKey::raw === "scss"',
  'src/languages/sfc.ts::styleLanguageKey::raw === "less"',
  'src/languages/sfc.ts::styleLanguageKey::raw === "css"',
  'src/util/syntax-tree.ts::isJvmLanguage::languageId === "java"',
  'src/util/syntax-tree.ts::isJvmLanguage::languageId === "kotlin"',
  'src/indexer/kotlin-call-compatibility.ts::kotlinCallableAcceptsTrailingLambda::declared.parsed.sup.id !== "kotlin"',
  'src/indexer/kotlin-callable-index.ts::projectCallablesNamed::supportForFileWithoutHeaderSample(mod.file, index.languageExtensions)?.id !== "kotlin"',
  'src/indexer/kotlin-lambda-receiver.ts::receiverOfProjectType::declaration?.site.parsed.sup.id !== "kotlin"',
  'src/indexer/member-lookup-policies/swift-property-witness.ts::namedProperties::context.sup.id !== "swift"',
  'src/indexer/member-lookup-policies/swift.ts::isSwiftFile::supportForFileWithoutHeaderSample(definition.file, index.languageExtensions)?.id === "swift"',
  'src/indexer/name-lookup-policies/index.ts::afterCrossModule::targetContext.sup.id !== "ts"',
  'src/indexer/name-lookup-policies/index.ts::afterCrossModule::targetContext.sup.id !== "tsx"',
  'src/indexer/navigation-cpp.ts::cppFunctionHasImplicitThis::sup.id !== "cpp"',
  'src/indexer/php-namespace-symbols.ts::buildPhpNamespaceSymbolIndex::supportForFileWithoutHeaderSample(moduleEntry.file, index.languageExtensions)?.id === "php"',
  'src/indexer/php-namespace-symbols.ts::phpModules.map callback::parsed.sup.id === "php"',
  'src/indexer/swift-enum.ts::<module>::supportForFileWithoutHeaderSample(module.file, use.index.languageExtensions)?.id !== "swift"',
  'src/sql/classify-sql-file.ts::isSqlFilePath::supportForFileWithoutHeaderSample(filePath, languageExtensions)?.id === "sql"',
  'src/util/csharp-project-usings.ts::csharpProjectUsingFiles::supportForFileWithoutHeaderSample(file, languageExtensions)?.id !== "csharp"',
  'src/util/resolution/csharp.ts::Object.entries(normalizeLanguageExtensions(languageExtensions) ?? {}).filter callback::languageId === "csharp"',
  'src/util/resolution/csharp.ts::readCsharpNamespaceFacts::support?.id !== "csharp"',
  'src/util/resolution/csharp.ts::readCsharpNamespaceFacts::retained?.sup?.id === "csharp"',
  'src/util/resolution/csharp.ts::isActiveCsharpFile::supportForFileWithoutHeaderSample(file, languageExtensions)?.id === "csharp"',
  'src/util/resolution/php.ts::<module>::parsed.sup.id !== "php"',
  'src/util/resolution/terraform.ts::entries .filter((entry) => entry.isFile() || entry.isSymbolicLink()) .map((entry callback::supportForFileWithoutHeaderSample(file, languageExtensions)?.id === "terraform"',
  "src/terraform/resolution.ts::isTerraformFile::supportForFileWithoutHeaderSample(file, index.languageExtensions)?.id === TERRAFORM_LANGUAGE_ID",
  "src/terraform/resolution.ts::computeFacts::parsed.sup.id !== TERRAFORM_LANGUAGE_ID",
]);
const ownerFiles = {
  A: [
    "src/graphs/symbol-graph-detailed/receiver-calls.ts",
    "src/indexer/member-selection.ts",
    "src/indexer/navigation-goto.ts",
    "src/indexer/shared-owner-identity.ts",
    "src/util/member-access.ts",
  ],
  B: [
    "src/graphs/symbol-graph-detailed.ts",
    "src/graphs/symbol-graph-detailed/ast.ts",
    "src/graphs/symbol-graph-detailed/edge-passes.ts",
    "src/graphs/symbol-graph-detailed/import-aliases.ts",
    "src/graphs/symbol-graph.ts",
    "src/impact/call-compatibility.ts",
    "src/indexer/navigation-references.ts",
    "src/indexer/navigation.ts",
  ],
  C: [
    "src/graphs/angularjs.ts",
    "src/indexer/build-index.ts",
    "src/indexer/build-workers.ts",
    "src/indexer/callable-identity.ts",
    "src/indexer/declaration-visibility.ts",
    "src/indexer/locals-and-exports.ts",
    "src/indexer/name-lookup-policies/implicit-self.ts",
    "src/indexer/name-resolution.ts",
    "src/indexer/navigation-local.ts",
    "src/indexer/public-surface.ts",
    "src/indexer/reference-context.ts",
    "src/indexer/reference-query-index.ts",
    "src/indexer/scope-lookup.ts",
    "src/indexer/scope-nodes.ts",
    "src/indexer/scope.ts",
    "src/indexer/symbols.ts",
    "src/util/bloom-filter.ts",
    "src/util/project-file-facts.ts",
  ],
  D: [
    "src/agent/rename-preview.ts",
    "src/document-links.ts",
    "src/duplicates/units.ts",
    "src/graph-edge-collector.ts",
    "src/graphs/specifiers.ts",
    "src/impact/analyzer.ts",
    "src/impact/map.ts",
    "src/indexer/build-cache/resolver-environment.ts",
    "src/indexer/compilation-units.ts",
    "src/indexer/expand-star-imports.ts",
    "src/indexer/imports.ts",
    "src/indexer/imports/import-binding-tables.ts",
    "src/indexer/imports/js-text-imports.ts",
    "src/indexer/imports/language-specific.ts",
    "src/indexer/imports/native-captures.ts",
    "src/indexer/incremental-plan.ts",
    "src/indexer/navigation-resolve.ts",
    "src/indexer/star-import-precedence.ts",
    "src/languages/callable-arity.ts",
    "src/util/jvm-tree.ts",
    "src/util/resolution.ts",
    "src/util/resolution/jvm.ts",
    "src/util/resolution/specifier-targets.ts",
    "src/util/syntax-tree.ts",
  ],
};

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(file));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(file);
  }
  return files;
}

function short(s, max = 240) {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

function nameOf(n, sf) {
  if (n.name) return short(n.name.getText(sf), 120);
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
    let p = n.parent;
    if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p))
      return short(p.name.getText(sf), 120);
    if (ts.isCallExpression(p)) return short(p.expression.getText(sf), 80) + " callback";
  }
  return "<module>";
}

function nearestFn(n, sf) {
  for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return nameOf(p, sf);
  return "<module>";
}

function frame(n, sf) {
  let p = n;
  while (p.parent) {
    let q = p.parent;
    if (ts.isIfStatement(q) && q.expression.pos <= n.pos && n.end <= q.expression.end) {
      return {
        kind: "if",
        condition: short(q.expression.getText(sf), 600),
        whenTrue: short(q.thenStatement.getText(sf), 380),
        whenFalse: q.elseStatement ? short(q.elseStatement.getText(sf), 200) : "",
      };
    }
    if (ts.isConditionalExpression(q) && q.condition.pos <= n.pos && n.end <= q.condition.end) {
      return {
        kind: "ternary",
        condition: short(q.condition.getText(sf), 600),
        whenTrue: short(q.whenTrue.getText(sf), 300),
        whenFalse: short(q.whenFalse.getText(sf), 300),
      };
    }
    if (ts.isReturnStatement(q))
      return {
        kind: "return",
        condition: short(q.expression?.getText(sf) ?? "", 600),
        whenTrue: "return expression",
        whenFalse: "",
      };
    if (ts.isVariableDeclaration(q))
      return {
        kind: "variable",
        condition: short(q.initializer?.getText(sf) ?? "", 600),
        whenTrue: "initialize " + short(q.name.getText(sf)),
        whenFalse: "",
      };
    if (ts.isSwitchStatement(q))
      return {
        kind: "switch",
        condition: short(q.expression.getText(sf), 300),
        whenTrue: "select case",
        whenFalse: "",
      };
    p = q;
  }
  return { kind: "expression", condition: short(n.getText(sf)), whenTrue: "evaluate expression", whenFalse: "" };
}

function assign(x) {
  const { file: f, function: fn, syntax: s } = x;
  if (s === "family-helper")
    return [
      "exempt",
      "central-family-helper",
      "Already-centralized ECMAScript family predicate; leave the family declaration and its calls intact.",
    ];
  if (f === "src/bootstrap/tree-sitter-languages.ts")
    return [
      "exempt",
      "parser-bootstrap",
      "Bootstrap selects which grammars are registered; identity is the registry key.",
    ];
  if (f === "src/cli/chunk.ts")
    return ["exempt", "cli-dispatch", "CLI dispatch for component chunking, not name/member resolution."];
  if (f === "src/chunking/chunk-sfc.ts" || f === "src/languages/file-prep.ts" || f === "src/languages/sfc.ts")
    return [
      "exempt",
      "component-language-identity",
      "Component framework or embedded-language tag selection/normalization, not a shared name/member rule.",
    ];
  if (f === "src/drift/languages.ts")
    return ["exempt", "serialized-language-name", "Translates an external language label for drift reports."];
  if (f === "src/document-links/language-ids.ts")
    return [
      "exempt",
      "central-family-helper",
      "One centralized graph-only document-language registry, not consumer-level semantic dispatch.",
    ];
  if (f === "src/document-links/check.ts")
    return [
      "exempt",
      "document-check",
      "Markdown link-checker selects Markdown documents, not a shared semantic lookup.",
    ];
  if (f === "src/indexer/build-cache/module-cache.ts" || f === "src/indexer/build-cache/project-snapshot.ts")
    return [
      "exempt",
      "cache-wire-validation",
      "Validates a persisted jvmPackageLanguageId wire enum; identity and accepted values are cache format, not resolution dispatch.",
    ];
  if (f === "src/languages/callable-arity.ts" && s === "named-membership")
    return [
      "exempt",
      "capability-registry-validation",
      "Checks membership in the central callable-arity language registry.",
    ];
  if (
    f === "src/indexer/member-lookup-policies/swift.ts" ||
    f === "src/indexer/member-lookup-policies/swift-property-witness.ts"
  )
    return [
      "exempt",
      "language-policy-boundary",
      "A Swift-owned policy verifies a target file is Swift before reading Swift syntax.",
    ];
  if (
    /^src\/indexer\/(?:kotlin-call-compatibility|kotlin-callable-index|kotlin-lambda-receiver|navigation-cpp|php-namespace-symbols|swift-enum)\.ts$/.test(
      f,
    )
  )
    return [
      "exempt",
      "language-module-boundary",
      "Single-language implementation checks a foreign target before applying its language-specific syntax; this is not shared consumer dispatch.",
    ];
  if (
    f === "src/util/csharp-project-usings.ts" ||
    f === "src/util/resolution/csharp.ts" ||
    f === "src/util/resolution/php.ts" ||
    f === "src/util/resolution/terraform.ts" ||
    f === "src/sql/classify-sql-file.ts" ||
    f === "src/terraform/resolution.ts"
  )
    return [
      "exempt",
      "language-module-boundary",
      "Single-language file/target classifier checks that a discovered or retained file belongs to the language it consumes.",
    ];
  if (f === "src/indexer/name-lookup-policies/index.ts")
    return [
      "exempt",
      "language-policy-boundary",
      "TypeScript-specific policy checks the target language before applying TypeScript overload semantics.",
    ];
  if (
    f === "src/indexer/imports/import-binding-tables.ts" ||
    f === "src/indexer/imports/js-text-imports.ts" ||
    f === "src/indexer/imports/language-specific.ts"
  )
    return ["move", "import-extraction", "SpecifierExtractionPolicy.collect"];
  if (f === "src/agent/rename-preview.ts")
    return ["move", "identifier-validation", "LanguageDefinition.identifierValidation"];
  if (f === "src/util/bloom-filter.ts")
    return [
      "move",
      "reference-prefilter",
      "LanguageDefinition.bloomAlternateKey / LanguageDefinition.bloomSourceTokens",
    ];
  if (f === "src/indexer/reference-context.ts")
    return ["move", "reference-context", "LanguageDefinition.referenceBlockPriorities"];
  if (f === "src/indexer/symbols.ts" || (f === "src/indexer/locals-and-exports.ts" && s === "named-membership"))
    return ["move", "docstring-capture", "LanguageDefinition.capturesDocstrings"];
  if (f === "src/indexer/scope-nodes.ts" && fn === "typeOnlyName")
    return ["move", "scope-type-position", "ScopeNodeRow.typeOnlyName"];
  if (f === "src/indexer/scope.ts" || f === "src/indexer/scope-lookup.ts")
    return ["move", "scope-binding", "ScopeNodeRow.bindingRules"];
  if (f === "src/util/member-access.ts") return ["move", "member-syntax", "MemberAccessRow.qualifiedAccess"];
  if (f === "src/graphs/symbol-graph-detailed/receiver-calls.ts")
    return ["move", "receiver-syntax", "MemberAccessRow.qualifiedAccess / MemberLookupPolicy.receiverResolution"];
  if (f === "src/indexer/member-selection.ts")
    return ["move", "member-selection", "MemberLookupPolicy.memberWalk / MemberLookupPolicy.separateMemberScopes"];
  if (
    f === "src/indexer/callable-identity.ts" ||
    f === "src/languages/callable-arity.ts" ||
    (f === "src/graphs/symbol-graph-detailed/ast.ts" && fn === "declarationMemberArity")
  )
    return ["move", "callable-identity", "CallableIdentityPolicy.forDeclaration / callable-arity tables"];
  if (f === "src/impact/map.ts") return ["move", "impact-syntax", "LanguageDefinition.impactDefinitionTypes"];
  if (f === "src/impact/call-compatibility.ts")
    return ["move", "callable-impact", "CallableIdentityPolicy.forDeclaration / MemberLookupPolicy.receiverResolution"];
  if (f === "src/impact/analyzer.ts") return ["move", "incremental-surface", "IndexLanguagePolicy.publicSurface"];
  if (f === "src/indexer/compilation-units.ts" || f === "src/util/jvm-tree.ts" || f === "src/util/syntax-tree.ts")
    return [
      "move",
      "unit-package-facts",
      "ImportResolutionRow.implicitCompilationUnit / ImportResolutionRow.packageSyntax",
    ];
  if (f === "src/indexer/public-surface.ts" || f === "src/indexer/incremental-plan.ts")
    return [
      "move",
      "incremental-surface",
      "IndexLanguagePolicy.publicSurface / ImportResolutionRow.externalSpecifierResolution",
    ];
  if (f === "src/indexer/declaration-visibility.ts")
    return ["move", "declaration-visibility", "MemberLookupPolicy.ownerResolution / MemberWalkRules.memberVisible"];
  if (
    f === "src/indexer/build-index.ts" ||
    f === "src/indexer/build-workers.ts" ||
    f === "src/indexer/build-cache/resolver-environment.ts" ||
    f === "src/util/project-file-facts.ts" ||
    f === "src/graphs/angularjs.ts"
  )
    return ["move", "index-build", "IndexLanguagePolicy.module"];
  if (f === "src/indexer/locals-and-exports.ts" || f === "src/graphs/symbol-graph-detailed/ast.ts")
    return ["move", "declaration-extraction", "IndexLanguagePolicy.declarations"];
  if (
    f === "src/graphs/specifiers.ts" ||
    f === "src/document-links.ts" ||
    f === "src/duplicates/units.ts" ||
    f === "src/indexer/imports.ts" ||
    f === "src/indexer/imports/native-captures.ts" ||
    f === "src/graph-edge-collector.ts"
  )
    return ["move", "import-extraction", "SpecifierExtractionPolicy.collect"];
  if (
    f === "src/util/resolution.ts" ||
    f === "src/util/resolution/specifier-targets.ts" ||
    f === "src/util/resolution/jvm.ts"
  )
    return ["move", "specifier-targets", "SpecifierTargetPolicy.resolve / ImportResolutionRow.packageSyntax"];
  if (
    f === "src/graphs/symbol-graph-detailed/import-aliases.ts" ||
    f === "src/indexer/navigation-resolve.ts" ||
    f === "src/indexer/expand-star-imports.ts" ||
    f === "src/indexer/star-import-precedence.ts" ||
    f === "src/graphs/symbol-graph.ts"
  )
    return ["move", "import-name-lookup", "NameLookupPolicy.imports / ImportResolutionRow"];
  if (
    f === "src/indexer/navigation-references.ts" ||
    f === "src/indexer/reference-query-index.ts" ||
    (f === "src/indexer/navigation.ts" &&
      (fn === "findReferencesInternal" ||
        /Reference|CallableFamily|OutOfLineReceiverOwner|ReceiverMemberDefinition|walk/.test(fn)))
  )
    return ["move", "reference-planning", "NameLookupPolicy.references / existing MemberLookupPolicy reference hooks"];
  if (f === "src/indexer/navigation.ts")
    return ["move", "positioned-name-lookup", "NameLookupPolicy.beforeLexical / MemberLookupPolicy.receiverResolution"];
  if (f === "src/indexer/navigation-local.ts")
    return ["move", "bare-binding", "NameLookupPolicy.bindingResolution / existing NameLookupPolicy stages"];
  if (f === "src/indexer/name-resolution.ts" || f === "src/indexer/name-lookup-policies/implicit-self.ts")
    return ["move", "bare-name", "NameLookupPolicy.beforeLexical / onLocal / afterCrossModule"];
  if (f === "src/indexer/navigation-goto.ts") {
    if (/Callee|memberAccessIsCall|memberAccessUse/.test(fn)) return ["move", "member-use", "MemberLookupPolicy.useOf"];
    if (/Owner|Container|Base|Hierarchy|uninherited|Uninherited|sameParameterTypes|hiddenReceiverType/i.test(fn))
      return ["move", "member-owner", "MemberLookupPolicy.ownerResolution / memberWalk"];
    return ["move", "receiver-resolution", "MemberLookupPolicy.receiverResolution / existing memberAccessRules"];
  }
  if (f === "src/indexer/shared-owner-identity.ts")
    return ["move", "member-owner", "MemberLookupPolicy.ownerResolution"];
  if (f.startsWith("src/graphs/symbol-graph-detailed"))
    return ["move", "graph-consumer", "MemberLookupPolicy.graph / existing callEdge and NameLookupPolicy stages"];
  return ["UNCLASSIFIED", "", ""];
}

function cliOptions(argv) {
  let root = defaultRoot;
  let summary = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--summary") summary = true;
    else if (argv[i] === "--root" && argv[i + 1]) root = path.resolve(argv[++i]);
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/language-check-inventory.mjs [--root <checkout>] [--summary]");
      process.exit(0);
    } else throw new Error("Unknown or incomplete option: " + argv[i]);
  }
  return { root, summary };
}

function registeredLanguageIds(files) {
  const ids = new Set(["javascript", "typescript"]);
  for (const file of files) {
    if (!file.replaceAll("\\", "/").includes("/languages/definitions/")) continue;
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === "id" && ts.isStringLiteral(node.initializer)) {
        ids.add(node.initializer.text);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "htmlStubLanguage"
      ) {
        const id = node.arguments[0];
        if (id && ts.isStringLiteral(id)) ids.add(id.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return ids;
}

function isLanguageOperand(text, aliases) {
  if (aliases.has(text) || text === "id") return true;
  if (/language|lang(?:Id)?\b/i.test(text)) return true;
  const normalized = text.replaceAll("?.", ".").replace(/\[["']id["']\]/g, ".id");
  return /(?:sup|support\w*)\b.*\.id\b/i.test(normalized);
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Track literal language constants, static membership lists, and aliases of a language identity. */
function sourceFacts(source, ids) {
  const declarations = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) declarations.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const literals = new Map();
  const sets = new Map();
  const aliases = new Set();
  for (const declaration of declarations) {
    if (!ts.isIdentifier(declaration.name)) continue;
    const value = unwrapExpression(declaration.initializer);
    const isConst =
      ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
    if (isConst && ts.isStringLiteral(value) && ids.has(value.text)) {
      literals.set(declaration.name.text, value.text);
    }
    let items = value;
    if (ts.isNewExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "Set") {
      items = value.arguments?.[0];
      if (items) items = unwrapExpression(items);
    }
    if (!items || !ts.isArrayLiteralExpression(items)) continue;
    const languages = items.elements
      .filter(ts.isStringLiteral)
      .map((entry) => entry.text)
      .filter((id) => ids.has(id));
    if (languages.length) sets.set(declaration.name.text, languages);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const value = unwrapExpression(declaration.initializer);
      if (ts.isObjectBindingPattern(declaration.name) && /(?:sup|support|lang)/i.test(value.getText(source))) {
        for (const element of declaration.name.elements) {
          const property = element.propertyName?.getText(source) ?? element.name.getText(source);
          if (property !== "id" || !ts.isIdentifier(element.name) || aliases.has(element.name.text)) continue;
          aliases.add(element.name.text);
          changed = true;
        }
      }
      if (!ts.isIdentifier(declaration.name) || aliases.has(declaration.name.text)) continue;
      const text = value.getText(source);
      const identityAccess = ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value);
      if ((identityAccess && isLanguageOperand(text, aliases)) || (ts.isIdentifier(value) && aliases.has(value.text))) {
        aliases.add(declaration.name.text);
        changed = true;
      }
    }
  }
  return { aliases, literals, sets };
}

function languageLiteral(node, ids, literals) {
  const value = unwrapExpression(node);
  if (ts.isStringLiteral(value) && ids.has(value.text)) return value.text;
  if (ts.isIdentifier(value)) return literals.get(value.text);
  return undefined;
}

/** Only registered helpers imported from their defining module are exempt family calls. */
function familyHelpers(source, relative) {
  const helpers = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    const familyModule =
      moduleName.endsWith("/js-family.js") ||
      moduleName.endsWith("/syntax-tree.js") ||
      moduleName.endsWith("/language-ids.js") ||
      moduleName.endsWith("/document-links.js");
    const bindings = statement.importClause?.namedBindings;
    if (!familyModule || !bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const exported = element.propertyName?.text ?? element.name.text;
      if (Object.hasOwn(familyMap, exported)) helpers.set(element.name.text, familyMap[exported]);
    }
  }
  if (relative === "src/util/syntax-tree.ts") helpers.set("isJvmLanguage", familyMap.isJvmLanguage);
  return helpers;
}

function relativeFile(root, file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function ownerFor(file) {
  for (const [owner, files] of Object.entries(ownerFiles)) {
    if (files.includes(file)) return owner;
  }
  return "unassigned";
}

/** Functions that contain several kinds of decision need a narrower destination than their file. */
function refineDecision(site) {
  const fn = site.function;
  const evidence = site.condition + " " + site.whenTrue;
  if (site.file === "src/indexer/navigation-goto.ts") {
    if (fn === "resolveExpression") {
      const usesImportLookup =
        /import|alias|binding|shadow|annotation|positionedJvmLookup|resolveJvmTypeName|resolveExport|resolveIndexedPhpClassReference/i.test(
          evidence,
        );
      if (usesImportLookup)
        return ["import-name-lookup", "NameLookupPolicy.imports / NameLookupPolicy.beforeCrossModule"];
    }
    if (fn === "resolveMemberAccessDefinition") {
      if (site.whenTrue === "initialize hierarchyLanguage") {
        return ["member-owner", "MemberLookupPolicy.ownerResolution / MemberLookupPolicy.memberWalk"];
      }
      if (/resolveJvmTypeName|csharpChainQualifier|hasCsharpStaticImports/.test(evidence)) {
        return ["import-name-lookup", "NameLookupPolicy.imports / NameLookupPolicy.beforeLexical"];
      }
    }
  }
  if (site.file === "src/graphs/symbol-graph-detailed/edge-passes.ts") {
    if (/Alias|Import|resolveTypeScriptNamespaceMember/.test(fn)) {
      return ["import-name-lookup", "NameLookupPolicy.imports / NameLookupPolicy.beforeLexical"];
    }
    if (/Owner|Base|Inheritance|Specifier|IdentifierRelations/.test(fn)) {
      return ["member-owner", "MemberLookupPolicy.ownerResolution / MemberLookupPolicy.graph"];
    }
    if (/ReceiverCall|resolveCallTarget|recordCallOrInstantiation|recordImplicitSelfMemberCall/.test(fn)) {
      return ["receiver-resolution", "MemberLookupPolicy.receiverResolution / MemberLookupPolicy.callEdge"];
    }
    if (fn === "tryResolveNode" || fn === "resolveNamedType") {
      return ["bare-name", "NameLookupPolicy.beforeLexical / NameLookupPolicy.beforeCrossModule"];
    }
  }
  if (site.file !== "src/graphs/symbol-graph-detailed.ts") return undefined;
  if (/resolveNamespaceAlias|resolveMemberPathFromModule|aliasTableAnswers/.test(fn)) {
    return ["import-name-lookup", "NameLookupPolicy.imports / NameLookupPolicy.beforeLexical"];
  }
  if (fn === "bareNameUse") return ["bare-name", "NameLookupPolicy.beforeLexical"];
  if (fn === "resolveMemberAccessTarget") return ["receiver-resolution", "MemberLookupPolicy.receiverResolution"];
  if (/recordCallableDeclarationAliases|recordTypeScriptCallableAliases/.test(fn)) {
    return ["callable-identity", "CallableIdentityPolicy.forDeclaration / getCallableArity"];
  }
  if (fn !== "buildSymbolGraphDetailed") return undefined;
  const usesPositionedImport =
    /csharpAliasUsesHiddenByMembers|warmCsharpOwnerChains|hasPythonDottedImports|hasIncompleteJvmPackage/.test(
      evidence,
    );
  if (usesPositionedImport) {
    return ["import-name-lookup", "NameLookupPolicy.imports / NameLookupPolicy.beforeLexical"];
  }
  if (/pythonMemberAccessResolvers/.test(evidence)) {
    return ["receiver-resolution", "MemberLookupPolicy.receiverResolution"];
  }
  if (/languageId !== "ts"|targetLanguageId !== "ts"|kotlinCallableAcceptsTrailingLambda/.test(evidence)) {
    return ["callable-identity", "CallableIdentityPolicy.forDeclaration / getCallableArity"];
  }
  if (site.expression === 'support?.id === "swift"') {
    return ["member-selection", "MemberLookupPolicy.memberNameKey / LanguageSupport.normalizeIdentifier"];
  }
  return undefined;
}

function classify(site) {
  let [status, category, destination] = assign(site);
  const boundary = category === "language-module-boundary" || category === "language-policy-boundary";
  const key = site.file + "::" + site.function + "::" + site.expression;
  const fixedExemption = status === "exempt" && site.syntax === "comparison";
  if ((boundary || fixedExemption) && !boundarySites.has(key)) {
    status = "move";
    category = "needs-classification";
    destination = "unclassified";
  }
  if (site.syntax === "family-helper") {
    status = "exempt";
    category = "central-family-helper";
    destination = "Already-centralized language family or graph-only capability helper.";
  }
  if (site.expression.startsWith("DECLARATION_RESOLVED_IMPORT_LANGUAGES.")) {
    status = "exempt";
    category = "central-family-helper";
    destination = "Derived from per-language import-resolution rows, not a consumer identity branch.";
  }
  if (site.expression.startsWith("HTML_LIKE_LANGUAGE_IDS.")) {
    status = "exempt";
    category = "central-family-helper";
    destination = "Centralized HTML-like extraction helper, including its file-path fallback.";
  }
  if (site.file === "src/util/syntax-tree.ts" && site.function === "isJvmLanguage" && boundarySites.has(key)) {
    status = "exempt";
    category = "central-family-helper";
    destination = "Centralized Java/Kotlin family predicate.";
  }
  if (site.dynamicMembership) {
    status = "exempt";
    category = "dynamic-or-central-registry";
    destination =
      "Dynamic native, provider, diagnostics, or incremental-history membership, not a fixed language check.";
  }
  if (site.expression.startsWith("jsFamilyLanguageIds.")) {
    status = "exempt";
    category = "central-family-helper";
    destination = "Central ECMAScript family registry filtered through registered language IDs.";
  }
  if (status === "UNCLASSIFIED") {
    status = "move";
    category = "needs-classification";
    destination = "unclassified";
  }
  if (status === "move") {
    const refined = refineDecision(site);
    if (refined) [category, destination] = refined;
  }
  if (
    site.file === "src/indexer/scope-nodes.ts" &&
    site.function === "typeOnlyName" &&
    site.languages.includes("kotlin")
  ) {
    destination = "ScopeNodeRow.typeOnlyParentTypes";
  }
  if (site.file === "src/languages/callable-arity.ts" && site.function === "memberLookupBinding") {
    destination = "CallableArityLanguageProfile.memberLookupBinding";
  }
  if (site.file === "src/graphs/symbol-graph-detailed/ast.ts" && site.function === "declarationMemberArity") {
    destination = "CallableArityLanguageProfile.graphDeclarationParameters";
  }
  if (site.file === "src/graphs/angularjs.ts" && status === "move")
    destination = "existing isJsTsLanguage family helper";
  if (category === "specifier-targets")
    destination =
      "SpecifierTargetPolicy.resolve / SpecifierTargetPolicy.resolveImport / ImportResolutionRow.packageSyntax";
  if (category === "unit-package-facts")
    destination = "ImportResolutionRow.implicitCompilationUnit / ImportResolutionRow.packageSyntax";
  if (category === "incremental-surface" && site.file === "src/indexer/public-surface.ts") {
    destination = "IndexLanguagePolicy.publicSurface / ImportResolutionRow.externalSpecifierResolution";
  }
  let decision = site.function + ": " + site.whenTrue + " from " + site.condition;
  if (site.kind === "if") decision = site.function + ": if " + site.condition + " then " + site.whenTrue;
  const result = { ...site, status, category, decision, owner: null };
  if (status !== "exempt") result.owner = ownerFor(site.file);
  delete result.dynamicMembership;
  if (status === "exempt") result.exemptionReason = destination;
  else result.hook = destination;
  return result;
}

function generate(root) {
  const files = walk(path.join(root, "src"));
  const ids = registeredLanguageIds(files);
  const sites = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const relative = relativeFile(root, file);
    const facts = sourceFacts(source, ids);
    const helpers = familyHelpers(source, relative);
    function add(node, languages, operand, syntax, dynamicMembership = false) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      const site = {
        file: relative,
        line: position.line + 1,
        column: position.character + 1,
        languages,
        operand,
        syntax,
        expression: short(node.getText(source), 500),
        function: nearestFn(node, source),
        ...frame(node, source),
        dynamicMembership,
      };
      sites.push(classify(site));
    }
    function visit(node) {
      if (
        ts.isBinaryExpression(node) &&
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
        ].includes(node.operatorToken.kind)
      ) {
        let literal = languageLiteral(node.left, ids, facts.literals);
        let operand = node.right;
        if (!literal) {
          literal = languageLiteral(node.right, ids, facts.literals);
          operand = node.left;
        }
        if (literal) {
          const value = operand.getText(source);
          const componentTag =
            ["framework", "raw"].includes(value) &&
            ["src/chunking/chunk-sfc.ts", "src/languages/file-prep.ts", "src/languages/sfc.ts"].includes(relative);
          if (isLanguageOperand(value, facts.aliases) || componentTag) add(node, [literal], value, "comparison");
        }
      }
      if (ts.isSwitchStatement(node) && isLanguageOperand(node.expression.getText(source), facts.aliases)) {
        for (const clause of node.caseBlock.clauses) {
          if (!ts.isCaseClause(clause)) continue;
          const literal = languageLiteral(clause.expression, ids, facts.literals);
          if (literal) add(clause, [literal], node.expression.getText(source), "switch-case");
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && helpers.has(node.expression.text)) {
        add(node, helpers.get(node.expression.text), short(node.arguments[0]?.getText(source) ?? ""), "family-helper");
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["includes", "has"].includes(node.expression.name.text) &&
        node.arguments.length
      ) {
        let receiver = node.expression.expression.getText(source);
        receiver = receiver.replace(/^\((.*) as readonly string\[\]\)$/, "$1");
        const argument = node.arguments[0].getText(source);
        if (Object.hasOwn(namedSets, receiver)) {
          add(node, facts.sets.get(receiver) ?? namedSets[receiver], argument, "named-membership");
        } else if (dynamicSets.has(relative + "::" + receiver)) {
          add(node, ["runtime-dependent"], argument, "named-membership", true);
        } else if (facts.sets.has(receiver) && isLanguageOperand(argument, facts.aliases)) {
          add(node, facts.sets.get(receiver), argument, "named-membership");
        } else if (
          ts.isArrayLiteralExpression(node.expression.expression) &&
          isLanguageOperand(argument, facts.aliases)
        ) {
          const languages = node.expression.expression.elements
            .filter(ts.isStringLiteral)
            .map((element) => element.text)
            .filter((id) => ids.has(id));
          if (languages.length) add(node, languages, argument, "membership");
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  sites.sort((left, right) => {
    if (left.file < right.file) return -1;
    if (left.file > right.file) return 1;
    return left.line - right.line || left.column - right.column;
  });
  const categories = {};
  for (const site of sites) categories[site.category] = (categories[site.category] ?? 0) + 1;
  const counts = {
    total: sites.length,
    comparisons: sites.filter((site) => site.syntax === "comparison").length,
    memberships: sites.filter((site) => site.syntax === "membership" || site.syntax === "named-membership").length,
    centralizedHelperCalls: sites.filter((site) => site.syntax === "family-helper").length,
    switchCases: sites.filter((site) => site.syntax === "switch-case").length,
    move: sites.filter((site) => site.status === "move").length,
    exempt: sites.filter((site) => site.status === "exempt").length,
    needsClassification: sites.filter((site) => site.category === "needs-classification").length,
    moveLines: new Set(sites.filter((site) => site.status === "move").map((site) => site.file + ":" + site.line)).size,
    files: new Set(sites.map((site) => site.file)).size,
  };
  const slices = {};
  for (const owner of ["A", "B", "C", "D", "unassigned"]) {
    const owned = sites.filter((site) => site.owner === owner);
    slices[owner] = { sites: owned.length, lines: new Set(owned.map((site) => site.file + ":" + site.line)).size };
  }
  return { schemaVersion: 1, sourceRoot: "src", counts, categories, slices, sites };
}

try {
  const options = cliOptions(process.argv.slice(2));
  const result = generate(options.root);
  if (options.summary) {
    const { counts, categories, slices } = result;
    console.log(JSON.stringify({ counts, categories, slices }, null, 2));
  } else console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
