import type { LanguageExtensionMap } from "../languages.js";
import type { SyntaxTreeLike } from "../languages/types.js";
import type { CsharpNamespaceFacts } from "./csharp-tree.js";
import type { JvmFileFacts } from "./jvm-tree.js";
import type { JvmLanguageId } from "./syntax-tree.js";

/** Per-file declarations only; project scans combine these after extraction finishes. Null means unavailable. */
export type ProjectFileFacts = {
  csharpNamespaceFacts?: CsharpNamespaceFacts | null;
  jvmFacts?: JvmFileFacts | null;
};

/** Collection and diagnostics for one language's per-file project declarations. */
export type ProjectFactsPolicy = Readonly<{
  slot: "csharp" | "jvm";
  degradationFact?: keyof ProjectFileFacts;
  collect: (
    source: string,
    tree: SyntaxTreeLike | null,
    parsePackageHead: (head: string, languageId: JvmLanguageId) => SyntaxTreeLike | null,
    packageHead: (source: string) => string,
  ) => ProjectFileFacts;
  /** Prime the language's project scan with an already extracted file's facts. */
  prime: (
    file: string,
    facts: ProjectFileFacts | undefined,
    extensions: LanguageExtensionMap | undefined,
    primeNamespaces: (file: string, facts: CsharpNamespaceFacts | null, extensions?: LanguageExtensionMap) => void,
    primePackage: (file: string, facts: JvmFileFacts | null) => void,
  ) => void;
  /** Select namespace facts for a module that has a full syntax tree. */
  namespaceFacts?: (tree: SyntaxTreeLike, facts: ProjectFileFacts | undefined) => CsharpNamespaceFacts;
}>;
