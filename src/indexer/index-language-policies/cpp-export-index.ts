import { cppQualifiedNameSegments } from "../../graphs/symbol-graph-detailed/receiver-calls.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import { sliceText } from "../../util/ast.js";
import { resolvedImportFile } from "../imports/context.js";
import type { DeclarationHooks } from "../language-hook-types.js";
import { SymbolKind, type ExportEntry } from "../types.js";

function cppQualifiedExportName(
  nameNode: SyntaxNodeLike,
  source: string,
  name: string,
  omitInlineNamespaces = false,
): string {
  const namespaceSegments: string[][] = [];
  let qualifiedSegments: string[] | null = null;
  let current: SyntaxNodeLike | null = nameNode;
  while (current) {
    if (!qualifiedSegments && current.type === "qualified_identifier") {
      // `a::C::run` nests `C::run` inside `a::(...)`; the outermost node carries the full path.
      while (current.parent?.type === "qualified_identifier") current = current.parent;
      if (current.parent?.type !== "using_declaration") {
        const segments = cppQualifiedNameSegments(current, source);
        if (segments.length > 1) qualifiedSegments = segments;
      }
    }
    if (current.type === "namespace_definition") {
      const namespaceName = current.childForFieldName("name");
      if (!namespaceName) {
        current = current.parent;
        continue;
      }
      const declaresNamespaceSegment =
        namespaceName.startIndex <= nameNode.startIndex && namespaceName.endIndex >= nameNode.endIndex;
      if (declaresNamespaceSegment) {
        qualifiedSegments =
          namespaceName.type === "nested_namespace_specifier"
            ? namespaceName.namedChildren
                .filter((child) => child.type === "namespace_identifier" && child.endIndex <= nameNode.endIndex)
                .map((child) => sliceText(child, source))
            : [name];
      } else if (!omitInlineNamespaces || current.child(0)?.type !== "inline") {
        namespaceSegments.unshift(cppQualifiedNameSegments(namespaceName, source));
      }
    }
    current = current.parent;
  }
  return [...namespaceSegments.flat(), ...(qualifiedSegments ?? [name])].join("::");
}

export const cppDeclarations: DeclarationHooks = {
  qualifiedExportName: cppQualifiedExportName,
  alternateExportName: (node, source, name) => cppQualifiedExportName(node, source, name, true),
  completeUsingExports(treeForUsingDeclarations, source, imports, exports, support, matchesExportScopeBlocker) {
    if (treeForUsingDeclarations) {
      const callableExports = new Map<string, { index: number; isDefinition: boolean }>();
      let retainedCount = 0;
      for (const entry of exports) {
        if (entry.type === "local" && entry.target.kind === SymbolKind.Function) {
          const callable = entry.target.callable;
          if (callable?.signature) {
            const key = `${entry.exportedAs}\0${callable.signature}`;
            const isDefinition = callable.definition === true;
            const existing = callableExports.get(key);
            if (existing) {
              if (isDefinition && !existing.isDefinition) {
                exports[existing.index] = entry;
                existing.isDefinition = true;
              }
              continue;
            }
            callableExports.set(key, { index: retainedCount, isDefinition });
          }
        }
        exports[retainedCount++] = entry;
      }
      exports.length = retainedCount;
    }
    const visitUsingDeclaration = (node: SyntaxNodeLike): void => {
      if (support.exportScopeBlockers.some((blocker) => matchesExportScopeBlocker(node, blocker))) return;
      if (node.type === "using_declaration") {
        const qualified =
          node.namedChildren.find((child) => child.type === "qualified_identifier") ??
          node.namedChildren
            .flatMap((child) => child.namedChildren)
            .find((child) => child.type === "qualified_identifier");
        if (qualified) {
          const importedSegments = cppQualifiedNameSegments(qualified, source);
          const importedName = importedSegments.join("::");
          const localName = importedSegments.at(-1);
          if (!localName) return;
          const exportedName = cppQualifiedExportName(node, source, localName);
          const exportedNames = [exportedName];
          if (exportedName !== localName) {
            const visibleAs = cppQualifiedExportName(node, source, localName, true);
            if (visibleAs !== exportedName) exportedNames.push(visibleAs);
          }
          const targets = exports.filter(
            (entry): entry is Extract<ExportEntry, { type: "local" }> =>
              entry.type === "local" && entry.exportedAs === importedName,
          );
          for (const exportedAs of exportedNames) {
            // Included declarations are not available during per-file extraction.
            // Retain the qualified target for resolution against the completed index.
            for (const imp of imports) {
              if (imp.kind !== "star") continue;
              const fromModule = resolvedImportFile(imp);
              if (fromModule === undefined) continue;
              exports.push({
                type: "reexport",
                exportedAs,
                fromModule,
                sourceSpecifier: importedName,
              });
            }
            for (const target of targets) {
              if (
                exports.some(
                  (entry) =>
                    entry.type === "local" &&
                    entry.exportedAs === exportedAs &&
                    entry.target.range.start.index === target.target.range.start.index,
                )
              ) {
                continue;
              }
              exports.push({
                type: "local",
                exportedAs,
                target: target.target,
              });
            }
          }
        }
        return;
      }
      for (const child of node.namedChildren) visitUsingDeclaration(child);
    };
    if (treeForUsingDeclarations) visitUsingDeclaration(treeForUsingDeclarations.rootNode);
  },
};
