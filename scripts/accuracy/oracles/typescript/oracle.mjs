#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { compareLocations, locationKey, sampleCandidates } from "../../accuracy-lib.mjs";

function argumentsFor(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!["--root", "--request", "--output"].includes(key) || !argv[index + 1]) {
      throw new Error("Usage: oracle.mjs --root <repository> --request <request.json> --output <response.json>");
    }
    if (result[key]) throw new Error(`Duplicate option: ${key}`);
    result[key] = path.resolve(argv[index + 1]);
  }
  if (!result["--root"] || !result["--request"] || !result["--output"]) throw new Error("Missing oracle arguments.");
  return result;
}

function normalized(file) {
  const absolute = path.resolve(file).replaceAll("\\", "/");
  return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
}

function validateRequest(request) {
  if (request.schemaVersion !== 1 || request.language !== "typescript" || !Array.isArray(request.files)) {
    throw new Error("Expected a schemaVersion 1 TypeScript oracle request.");
  }
  for (const file of request.files) {
    const segments = typeof file === "string" ? file.split("/") : [];
    const portable = segments.length && segments.every((part) => part && part !== "." && part !== "..");
    if (!portable || file.includes("\\") || path.isAbsolute(file) || /^[A-Za-z]:/.test(file)) {
      throw new Error(`Expected a project-relative POSIX source path: ${file}`);
    }
  }
  if (new Set(request.files).size !== request.files.length) throw new Error("Oracle files must be unique.");
  if (!Number.isInteger(request.seed) || request.seed < 0 || request.seed > 0xffffffff) {
    throw new Error("Oracle seed must be an unsigned 32-bit integer.");
  }
  for (const name of ["maxSites", "maxDeclarations"]) {
    if (!Number.isSafeInteger(request[name]) || request[name] < 0)
      throw new Error(`${name} must be a nonnegative integer.`);
  }
}

const DECLARATION_NAME_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.TypeParameter,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ImportSpecifier,
]);

function isDeclarationName(node) {
  const parent = node.parent;
  if (DECLARATION_NAME_KINDS.has(parent.kind) && parent.name === node) return true;
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  // `export { source as publicName }`: publicName is not a use of a local symbol.
  return ts.isExportSpecifier(parent) && !!parent.propertyName && parent.name === node;
}

function terminalName(expression, node) {
  if (expression === node) return true;
  return ts.isPropertyAccessExpression(expression) && expression.name === node;
}

function classify(node) {
  const parent = node.parent;
  let expression = node;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) expression = parent;
  const invocation = expression.parent;
  if (ts.isNewExpression(invocation) && terminalName(invocation.expression, node)) return "constructor";
  if (ts.isCallExpression(invocation) && invocation.expression === expression) {
    return ts.isPropertyAccessExpression(expression) ? "member-call" : "bare-call";
  }
  for (let ancestor = parent; ancestor && !ts.isSourceFile(ancestor); ancestor = ancestor.parent) {
    if (
      ts.isImportDeclaration(ancestor) ||
      ts.isImportEqualsDeclaration(ancestor) ||
      ts.isExportDeclaration(ancestor)
    ) {
      return "import";
    }
    if (ts.isTypeNode(ancestor) || ts.isExpressionWithTypeArguments(ancestor)) return "type-reference";
    if (ts.isStatement(ancestor)) break;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return "member-access";
  return "other-identifier";
}

function hasFunctionOwner(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return true;
  }
  return false;
}

function declarationKind(node) {
  const parent = node.parent;
  if (parent.name !== node) return null;
  if (ts.isFunctionDeclaration(parent)) return hasFunctionOwner(parent) ? null : "function";
  if (ts.isClassDeclaration(parent)) return hasFunctionOwner(parent) ? null : "class";
  if (ts.isInterfaceDeclaration(parent)) return hasFunctionOwner(parent) ? null : "interface";
  if (ts.isTypeAliasDeclaration(parent)) return hasFunctionOwner(parent) ? null : "type";
  if (ts.isEnumDeclaration(parent)) return hasFunctionOwner(parent) ? null : "enum";
  if (ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)) return "method";
  if (ts.isGetAccessor(parent) || ts.isSetAccessor(parent) || ts.isPropertySignature(parent)) return "property";
  if (ts.isPropertyDeclaration(parent)) return "field";
  if (ts.isEnumMember(parent)) return "constant";
  if (ts.isVariableDeclaration(parent) && !hasFunctionOwner(parent)) {
    return parent.parent.flags & ts.NodeFlags.Const ? "constant" : "variable";
  }
  return null;
}

function uniqueLocations(locations) {
  const unique = new Map(locations.map((location) => [locationKey(location), location]));
  return [...unique.values()].sort(compareLocations);
}

function run(root, request) {
  const configErrors = [];
  const defaults = {
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  let options = defaults;
  const configPath = path.join(root, "tsconfig.json");
  if (fs.existsSync(configPath)) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) configErrors.push(config.error);
    if (config.config) {
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
      options = { ...defaults, ...parsed.options };
      configErrors.push(...parsed.errors);
    }
  }
  options = { ...options, noEmit: true, skipLibCheck: true, types: [] };
  // No implicit project references, excluded source imports, or installed package types may expand this program.
  const sourcePaths = request.files.map((file) => path.resolve(root, file));
  const relativePaths = new Map(sourcePaths.map((file, index) => [normalized(file), request.files[index]]));
  const libraryRoot = `${normalized(path.dirname(ts.getDefaultLibFilePath(options)))}/`;
  const allowed = (file) => relativePaths.has(normalized(file)) || normalized(file).startsWith(libraryRoot);
  const host = {
    getScriptFileNames: () => sourcePaths,
    getScriptVersion: () => "1",
    getScriptSnapshot: (file) => {
      if (!allowed(file)) return undefined;
      const contents = ts.sys.readFile(file);
      return contents === undefined ? undefined : ts.ScriptSnapshot.fromString(contents);
    },
    getCompilationSettings: () => options,
    getCurrentDirectory: () => root,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: (file) => allowed(file) && ts.sys.fileExists(file),
    readFile: (file) => (allowed(file) ? ts.sys.readFile(file) : undefined),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => "\n",
  };
  const service = ts.createLanguageService(host);
  try {
    const program = service.getProgram();
    if (!program) throw new Error("TypeScript language service did not create a program.");
    const position = (file, offset) => {
      const source = program.getSourceFile(file);
      if (!source) throw new Error(`Oracle source file unavailable: ${file}`);
      const point = source.getLineAndCharacterOfPosition(offset);
      return { file: relativePaths.get(normalized(file)), line: point.line + 1, column: point.character + 1 };
    };
    const candidates = [];
    const declarations = [];
    for (const file of sourcePaths) {
      const source = program.getSourceFile(file);
      if (!source) throw new Error(`Requested source file unavailable: ${file}`);
      const visit = (node) => {
        if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
          const location = position(file, node.getStart(source));
          const candidate = {
            ...location,
            name: node.getText(source),
            absoluteFile: file,
            offset: node.getStart(source),
            node,
          };
          if (!isDeclarationName(node)) candidates.push({ ...candidate, form: classify(node) });
          const kind = declarationKind(node);
          if (kind) declarations.push({ ...candidate, kind });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    const checker = program.getTypeChecker();
    const sites = sampleCandidates(candidates, request.seed, request.maxSites).map((candidate) => {
      const symbol = checker.getSymbolAtLocation(candidate.node);
      let targetSymbol = symbol;
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) targetSymbol = checker.getAliasedSymbol(symbol);
      const unresolvedAlias = symbol !== targetSymbol && !targetSymbol?.declarations?.length;
      // The language service falls back to the import binding for an unresolved alias. That is not a true definition.
      const answers = unresolvedAlias
        ? []
        : (service.getDefinitionAtPosition(candidate.absoluteFile, candidate.offset) ?? []);
      const definitions = [];
      let external = false;
      for (const answer of answers) {
        if (!relativePaths.has(normalized(answer.fileName))) {
          external = true;
          continue;
        }
        definitions.push(position(answer.fileName, answer.textSpan.start));
      }
      const isClassConstructor = candidate.form === "constructor" && targetSymbol?.declarations?.some(ts.isClassLike);
      let declarationSymbol = targetSymbol;
      if (isClassConstructor) {
        const parent = candidate.node.parent;
        const creation = ts.isPropertyAccessExpression(parent) ? parent.parent : parent;
        declarationSymbol = checker.getTypeAtLocation(creation).getSymbol();
      }
      // Overload signatures and implementations (and merged declarations) share one compiler symbol.
      // Keep every proven name token, rather than penalizing a valid implementation target.
      const includeDeclarations = isClassConstructor || declarationSymbol?.declarations?.length > 1;
      if (answers.length && includeDeclarations) {
        for (const declaration of declarationSymbol?.declarations ?? []) {
          const name = declaration.name;
          if (!name || !(ts.isIdentifier(name) || ts.isPrivateIdentifier(name))) continue;
          const source = declaration.getSourceFile();
          if (!relativePaths.has(normalized(source.fileName))) {
            external = true;
            continue;
          }
          definitions.push(position(source.fileName, name.getStart(source)));
        }
      }
      return {
        file: candidate.file,
        line: candidate.line,
        column: candidate.column,
        name: candidate.name,
        form: candidate.form,
        definitions: uniqueLocations(definitions),
        external: external && !definitions.length,
      };
    });
    const sampledDeclarations = sampleCandidates(declarations, request.seed, request.maxDeclarations).map(
      (candidate) => {
        const references = [];
        const groups = service.findReferences(candidate.absoluteFile, candidate.offset) ?? [];
        for (const group of groups) {
          for (const reference of group.references) {
            if (reference.isDefinition || !relativePaths.has(normalized(reference.fileName))) continue;
            references.push(position(reference.fileName, reference.textSpan.start));
          }
        }
        const relatedDeclarations = [];
        const symbol = checker.getSymbolAtLocation(candidate.node);
        const ownKey = locationKey(candidate);
        for (const declaration of symbol?.declarations ?? []) {
          const name = declaration.name;
          if (!name || !(ts.isIdentifier(name) || ts.isPrivateIdentifier(name))) continue;
          const source = declaration.getSourceFile();
          if (!relativePaths.has(normalized(source.fileName))) continue;
          const location = position(source.fileName, name.getStart(source));
          if (locationKey(location) !== ownKey) relatedDeclarations.push(location);
        }
        return {
          file: candidate.file,
          line: candidate.line,
          column: candidate.column,
          name: candidate.name,
          kind: candidate.kind,
          references: uniqueLocations(references),
          relatedDeclarations: uniqueLocations(relatedDeclarations),
        };
      },
    );
    const diagnostics = [...configErrors, ...program.getOptionsDiagnostics()];
    for (const source of sourcePaths) {
      diagnostics.push(...service.getSyntacticDiagnostics(source));
    }
    const errors = diagnostics
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
      .map((diagnostic) => {
        const message = `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
        if (!diagnostic.file || diagnostic.start === undefined) return message;
        const point = position(diagnostic.file.fileName, diagnostic.start);
        return `${point.file}:${point.line}:${point.column}: ${message}`;
      });
    return {
      schemaVersion: 1,
      language: "typescript",
      oracle: { name: "typescript-language-service", version: ts.version },
      sites,
      declarations: sampledDeclarations,
      diagnostics: {
        files: sourcePaths.length,
        unresolvedSites: sites.filter((site) => !site.external && !site.definitions.length).length,
        errors,
      },
    };
  } finally {
    service.dispose();
  }
}

try {
  const args = argumentsFor(process.argv.slice(2));
  const request = JSON.parse(fs.readFileSync(args["--request"], "utf8"));
  validateRequest(request);
  const response = run(args["--root"], request);
  fs.mkdirSync(path.dirname(args["--output"]), { recursive: true });
  fs.writeFileSync(args["--output"], `${JSON.stringify(response, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`TypeScript oracle: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
