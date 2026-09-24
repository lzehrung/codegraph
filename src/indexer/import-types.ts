import type { FileId, Range } from "../types.js";

export type ImportBinding =
  | {
      kind: "default";
      local: string;
      from: string;
      /** UTF-16 range of the local binding token in the importing file. */
      localRange?: Range;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
      mechanism?: "es" | "cjs" | "python" | "php";
      /** Whether this Python import is declared at the module's top level. */
      moduleLevel?: boolean;
      resolvedType?: "heuristic" | "precise";
      confidence?: number;
    }
  | {
      kind: "named";
      local: string;
      imported: string;
      from: string;
      /** True when the source spells an alias even if the alias equals the imported name. */
      explicitAlias?: boolean;
      /** UTF-16 range of the imported (source) name token, before any `as` alias. */
      importedRange?: Range;
      /**
       * UTF-16 range of the local binding token. For an unaliased specifier this is the
       * same range as `importedRange`; for `import { a as b }` it is the alias token.
       */
      localRange?: Range;
      phpImportType?: "class" | "function" | "const";
      /** Namespace retained when a C include expands tags and ordinary names. */
      cNamespace?: "tag" | "ordinary";
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
      mechanism?: "es" | "cjs" | "python" | "php";
      /** Whether this Python import is declared at the module's top level. */
      moduleLevel?: boolean;
      resolvedType?: "heuristic" | "precise";
      confidence?: number;
    }
  | {
      kind: "namespace";
      localNS: string;
      from: string;
      /** UTF-16 range of the namespace binding token. */
      localRange?: Range;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
      mechanism?: "es" | "cjs" | "python" | "php";
      /** Whether this Python import is declared at the module's top level. */
      moduleLevel?: boolean;
      resolvedType?: "heuristic" | "precise";
      confidence?: number;
    }
  | {
      kind: "star";
      from: string;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
      mechanism?: "es" | "cjs" | "python" | "php";
      /** Whether this Python import is declared at the module's top level. */
      moduleLevel?: boolean;
      resolvedType?: "heuristic" | "precise";
      confidence?: number;
    };

/** Use the caller's normalized file path and preserve separate C include namespaces. */
export function importNodeId(file: string, binding: Exclude<ImportBinding, { kind: "star" }>): string {
  const name = binding.kind === "namespace" ? binding.localNS : binding.local;
  const namespace = binding.kind === "named" ? binding.cNamespace : undefined;
  return `${file}::${name}::import${namespace ? `:${namespace}` : ""}`;
}
