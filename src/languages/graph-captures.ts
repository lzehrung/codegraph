/**
 * Shared capture vocabulary for import-bearing queries only
 * (`graph.imports` and `graph.importBindings`).
 *
 * `@stmt` plus `@from` are required. `@from` is the path-bearing node (module
 * specifier, include path, `use` name). The optional names are produced only
 * when the grammar has a node for them; a language that cannot express one
 * must not invent a capture.
 *
 * This union is not a global query-capture schema. Two other `@mod` spellings
 * are a different vocabulary and must not be renamed to `@from`:
 * - JavaScript CommonJS export queries bind `@mod` to the identifier `module`
 *   in `module.exports`, gated by `(#eq? @mod "module")`. That capture is an
 *   identifier-equality check, not a path.
 * - `src/duplicates/units.ts` uses `@mod` in duplicate-masking queries for
 *   Ruby `load` and Zig `@cImport`. Different subsystem, no capture-schema
 *   contract.
 *
 * Predicate-only names (`attr`, `tag`, `fn`, `req`, `method`) and JS-family
 * CommonJS export captures (`pattern`, `cjs_*`, the CJS `@mod` above) stay
 * outside this union. Do not "fix" those to match `GraphImportCapture`.
 */

export const GRAPH_IMPORT_REQUIRED_CAPTURES = ["stmt", "from"] as const;
export const GRAPH_IMPORT_OPTIONAL_CAPTURES = ["alias", "wild", "iname", "def", "ns", "type_kw"] as const;
export const GRAPH_IMPORT_CAPTURES = [...GRAPH_IMPORT_REQUIRED_CAPTURES, ...GRAPH_IMPORT_OPTIONAL_CAPTURES] as const;

export type GraphImportRequiredCapture = (typeof GRAPH_IMPORT_REQUIRED_CAPTURES)[number];
export type GraphImportOptionalCapture = (typeof GRAPH_IMPORT_OPTIONAL_CAPTURES)[number];
export type GraphImportCapture = (typeof GRAPH_IMPORT_CAPTURES)[number];

/** `@name` token for a typed import capture. Unknown names fail at the call site. */
export function graphCapture(name: GraphImportCapture): `@${GraphImportCapture}` {
  return `@${name}`;
}

export type GraphImportCaptureMap<T> = Partial<Record<GraphImportCapture, T>>;

/** Typed lookup so an unknown capture name is a typecheck error, not a silent miss. */
export function importCapture<T>(
  caps: GraphImportCaptureMap<T> | Partial<Record<string, T>>,
  name: GraphImportCapture,
): T | undefined {
  return caps[name];
}

export function isGraphImportCapture(name: string): name is GraphImportCapture {
  return (GRAPH_IMPORT_CAPTURES as readonly string[]).includes(name);
}

export function graphImportCaptures<T>(byName: Record<string, T | undefined>): GraphImportCaptureMap<T> {
  const out: GraphImportCaptureMap<T> = {};
  for (const name of GRAPH_IMPORT_CAPTURES) {
    const capture = byName[name];
    if (capture !== undefined) out[name] = capture;
  }
  return out;
}

/** Compile error if `"mod"` is ever added: that name is identifier-equality, not a path. */
type AssertNever<T extends never> = T;
export type GraphImportCaptureExcludesMod = AssertNever<Extract<GraphImportCapture, "mod">>;
