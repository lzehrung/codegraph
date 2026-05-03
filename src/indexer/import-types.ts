import type { FileId } from "../types.js";

export type ImportBinding =
  | {
      kind: "default";
      local: string;
      from: string;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
      mechanism?: "es" | "cjs" | "python" | "php";
      resolvedType?: "heuristic" | "precise";
      confidence?: number;
    }
  | {
      kind: "named";
      local: string;
      imported: string;
      from: string;
      phpImportType?: "class" | "function" | "const";
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
      mechanism?: "es" | "cjs" | "python" | "php";
      resolvedType?: "heuristic" | "precise";
      confidence?: number;
    }
  | {
      kind: "namespace";
      localNS: string;
      from: string;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
      mechanism?: "es" | "cjs" | "python" | "php";
      resolvedType?: "heuristic" | "precise";
      confidence?: number;
    }
  | {
      kind: "star";
      from: string;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
      mechanism?: "es" | "cjs" | "python" | "php";
      resolvedType?: "heuristic" | "precise";
      confidence?: number;
    };
