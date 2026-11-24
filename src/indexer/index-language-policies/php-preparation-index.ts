import { ProjectedSyntaxTree } from "../../native/projected-tree.js";
import { primePhpModuleImportNames } from "../../util/resolution/php-module-facts-cache.js";
import type { ModuleIndexHooks } from "../language-hook-types.js";
import { attemptParsePreparedFileContext } from "../parse-context.js";
import { collectParseErrorRanges } from "../parse-errors.js";
import {
  collectPhpModuleImportNames,
  phpDeclarationImportNames,
  phpModuleImportNamesFromDeclarations,
} from "../php-namespace-symbols.js";

export const phpModule: ModuleIndexHooks = {
  prepare(prepared, options, collectModule) {
    const attempt = attemptParsePreparedFileContext(prepared);
    prepared.projectFactsParse = attempt;
    const parsed = attempt.parsed;
    if (!parsed || !prepared.nativeQueries) {
      prepared.phpModuleImportNames = null;
      primePhpModuleImportNames(prepared.file, null);
      return;
    }
    const module = collectModule(prepared.file, prepared.source, prepared.sup, [], {
      tree: parsed.tree,
      nativeQueries: prepared.nativeQueries,
      ...(options?.logLevel ? { logLevel: options.logLevel } : {}),
    });
    if (parsed.tree instanceof ProjectedSyntaxTree) module.parseErrorRanges = collectParseErrorRanges(parsed.tree);
    const names = collectPhpModuleImportNames(module, parsed);
    module.phpDeclarationNames = phpDeclarationImportNames(names);
    prepared.phpModule = module;
    prepared.phpModuleImportNames = names;
    primePhpModuleImportNames(prepared.file, names);
  },
  collectFacts(file, source, tree, support, nativeQueries, module) {
    if (tree && nativeQueries && !module.phpDeclarationNames) {
      module.phpDeclarationNames = phpDeclarationImportNames(
        collectPhpModuleImportNames(module, { source, tree, sup: support }),
      );
    }
    if (module.phpDeclarationNames && module.parserDegraded) {
      const names = phpModuleImportNamesFromDeclarations(module.phpDeclarationNames, module);
      module.phpDeclarationNames = phpDeclarationImportNames(names);
      primePhpModuleImportNames(file, names);
    }
  },
};
