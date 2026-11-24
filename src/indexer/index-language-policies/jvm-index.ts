import type { SyntaxTreeLike } from "../../languages/types.js";
import { collectJvmFileFacts, jvmPackageName } from "../../util/jvm-tree.js";
import type { ProjectFactsPolicy } from "../../util/project-file-facts-types.js";
import type { JvmLanguageId } from "../../util/syntax-tree.js";

function jvmProjectFacts(languageId: JvmLanguageId): ProjectFactsPolicy {
  return {
    slot: "jvm",
    collect(source, tree, parsePackageHead, packageHead) {
      if (tree) return { jvmFacts: collectJvmFileFacts(tree, languageId) };
      let head: SyntaxTreeLike | null = null;
      try {
        head = parsePackageHead(packageHead(source), languageId);
      } catch {
        // A failed bounded parse cannot place the file in a package.
      }
      return {
        jvmFacts: head ? { packageName: jvmPackageName(head, languageId), symbols: [], incomplete: true } : null,
      };
    },
    prime: (file, facts, _extensions, _primeNamespaces, primePackage) => primePackage(file, facts?.jvmFacts ?? null),
  };
}

export const javaProjectFacts = jvmProjectFacts("java");
export const kotlinProjectFacts = jvmProjectFacts("kotlin");
