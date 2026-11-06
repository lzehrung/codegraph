import { expect } from "vitest";
import { buildSymbolGraphDetailed, findReferences, goToDefinition, type ProjectIndex } from "../../src/index.js";
import { fileIdentityKey } from "../../src/util/paths.js";

export const PYTHON_ANNOTATION_SOURCES: Readonly<Record<string, string>> = {
  "models.py": "class T:\n    pass\ndef annotation_type():\n    return T\nclass f:\n    pass\n",
  "decoy.py": "class T:\n    pass\ndef annotation_type():\n    return T\n",
  "main.py": [
    "from models import T",
    "def run(T, value: T = None):",
    "    return T, value",
    "def ordinary(T, value: T) -> T:",
    "    return T, value",
    "def positional(T, /, value: T = None):",
    "    return T, value",
    "def keyword(T, *, value: T):",
    "    return T, value",
    "def variadic(T, *values: T, **named: T) -> T:",
    "    return T, values, named",
    "def body_local(value: T) -> T:",
    "    T = 1",
    "    return T",
    "def outer(T):",
    "    def nested(T, value: T) -> T:",
    "        return T, value",
    "    return nested",
    "def outer_local():",
    "    T = 2",
    "    def nested(T, value: T = None) -> T:",
    "        return T, value",
    "    return nested",
    "class Owner:",
    "    T = int",
    "    def method(self, T, value: T) -> T:",
    "        return T, value",
    "def self_typed(T: T) -> T:",
    "    return T",
    "def defaults(T: T = T) -> T:",
    "    return T",
    "",
  ].join("\n"),
  "future.py": [
    "from __future__ import annotations",
    "from models import T",
    "def postponed(T, value: T) -> T:",
    "    return T, value",
    'def quoted(T, value: "T") -> "T":',
    "    return T, value",
    "",
  ].join("\n"),
  "calls.py": [
    "from models import annotation_type",
    "def called(annotation_type, value: annotation_type()) -> annotation_type():",
    "    return annotation_type, value",
    "",
  ].join("\n"),
  "self_named.py": [
    "from models import annotation_type",
    "def annotation_type(value: annotation_type()) -> annotation_type():",
    "    return annotation_type",
    "",
  ].join("\n"),
  "eager_self.py": ["from models import f", "def f(value: f = f) -> f:", "    return f", ""].join("\n"),
  "postponed_self.py": [
    "from __future__ import annotations",
    "from models import f",
    "def f(value: f = f) -> f:",
    "    return f",
    "",
  ].join("\n"),
  "postponed_scope.py": [
    "from __future__ import annotations",
    "from models import T",
    "def outer(T):",
    "    def inner(value: T = T) -> T:",
    "        return T, value",
    "    return inner",
    "def outer_local():",
    "    T = 1",
    "    def inner(value: T = T) -> T:",
    "        return T, value",
    "    return inner",
    "class Owner:",
    "    T = int",
    "    def method(self, value: T = T) -> T:",
    "        return T, value",
    "def global_control(value: T = T) -> T:",
    "    return T, value",
    "def assigned_later():",
    "    def inner(value: T) -> T:",
    "        return T, value",
    "    T = 2",
    "    return inner",
    "",
  ].join("\n"),
  "postponed_unbound.py": [
    "from __future__ import annotations",
    "def outer(T):",
    "    def inner(value: T) -> T:",
    "        return T, value",
    "    return inner",
    "class Owner:",
    "    T = int",
    "    def method(self, value: T) -> T:",
    "        return T, value",
    "",
  ].join("\n"),
  "postponed_calls.py": [
    "from __future__ import annotations",
    "from models import annotation_type",
    "def lazy(annotation_type, value: annotation_type()) -> annotation_type():",
    "    return annotation_type, value",
    "def eager(value=annotation_type()):",
    "    return value",
    "def combined(annotation_type, value: annotation_type()=annotation_type()) -> annotation_type():",
    "    return annotation_type, value",
    "import models",
    "def lazy_namespace(value: models.annotation_type()) -> models.annotation_type():",
    "    return value",
    "def eager_namespace(value=models.annotation_type()):",
    "    return value",
    "",
  ].join("\n"),
};

export type PythonAnnotationSite = { file: string; line: number; column: number };

export function pythonAnnotationSite(file: string, line: number, token: string, occurrence = 1): PythonAnnotationSite {
  const text = PYTHON_ANNOTATION_SOURCES[file]!.split("\n")[line - 1]!;
  let at = -1;
  for (let count = 0; count < occurrence; count += 1) at = text.indexOf(token, at + 1);
  if (at < 0) throw new Error(`Missing annotation fixture token ${file}:${line}: ${token}`);
  return { file, line, column: at + 1 };
}

const t = (line: number, occurrence = 1): PythonAnnotationSite =>
  pythonAnnotationSite("main.py", line, "T", occurrence);

/** Exact semantic partitions: declaration plus reads, never neighboring parameter/body-local decoys. */
export const PYTHON_ANNOTATION_BINDINGS: ReadonlyArray<{
  label: string;
  declaration: PythonAnnotationSite;
  reads: readonly PythonAnnotationSite[];
}> = [
  {
    label: "imported type",
    declaration: pythonAnnotationSite("models.py", 1, "T"),
    reads: [
      pythonAnnotationSite("models.py", 4, "T"),
      t(1),
      t(2, 2),
      t(4, 2),
      t(4, 3),
      t(6, 2),
      t(8, 2),
      t(10, 2),
      t(10, 3),
      t(10, 4),
      t(12),
      t(12, 2),
      t(28, 2),
      t(28, 3),
      t(30, 2),
      t(30, 3),
      t(30, 4),
      pythonAnnotationSite("future.py", 2, "T"),
      pythonAnnotationSite("future.py", 3, "T", 2),
      pythonAnnotationSite("future.py", 3, "T", 3),
      pythonAnnotationSite("postponed_scope.py", 2, "T"),
      pythonAnnotationSite("postponed_scope.py", 4, "T"),
      pythonAnnotationSite("postponed_scope.py", 4, "T", 3),
      pythonAnnotationSite("postponed_scope.py", 9, "T"),
      pythonAnnotationSite("postponed_scope.py", 9, "T", 3),
      pythonAnnotationSite("postponed_scope.py", 14, "T"),
      pythonAnnotationSite("postponed_scope.py", 14, "T", 3),
      pythonAnnotationSite("postponed_scope.py", 15, "T"),
      pythonAnnotationSite("postponed_scope.py", 16, "T"),
      pythonAnnotationSite("postponed_scope.py", 16, "T", 2),
      pythonAnnotationSite("postponed_scope.py", 16, "T", 3),
      pythonAnnotationSite("postponed_scope.py", 17, "T"),
      pythonAnnotationSite("postponed_scope.py", 19, "T"),
      pythonAnnotationSite("postponed_scope.py", 19, "T", 2),
    ],
  },
  ...[
    [2, 3],
    [4, 5],
    [6, 7],
    [8, 9],
    [10, 11],
    [28, 29],
    [30, 31],
  ].map(([declaration, body]) => ({
    label: `parameter on line ${declaration}`,
    declaration: t(declaration!),
    reads: [t(body!)],
  })),
  { label: "body local", declaration: t(13), reads: [t(14)] },
  { label: "enclosing parameter", declaration: t(15), reads: [t(16, 2), t(16, 3)] },
  { label: "nested parameter", declaration: t(16), reads: [t(17)] },
  { label: "enclosing local", declaration: t(20), reads: [t(21, 2), t(21, 3)] },
  { label: "nested parameter with default", declaration: t(21), reads: [t(22)] },
  { label: "class local", declaration: t(25), reads: [t(26, 2), t(26, 3)] },
  { label: "method parameter", declaration: t(26), reads: [t(27)] },
  {
    label: "postponed parameter",
    declaration: pythonAnnotationSite("future.py", 3, "T"),
    reads: [pythonAnnotationSite("future.py", 4, "T")],
  },
  {
    label: "quoted parameter",
    declaration: pythonAnnotationSite("future.py", 5, "T"),
    reads: [pythonAnnotationSite("future.py", 6, "T")],
  },
  {
    label: "annotation callable",
    declaration: pythonAnnotationSite("models.py", 3, "annotation_type"),
    reads: [
      pythonAnnotationSite("calls.py", 1, "annotation_type"),
      pythonAnnotationSite("calls.py", 2, "annotation_type", 2),
      pythonAnnotationSite("calls.py", 2, "annotation_type", 3),
      pythonAnnotationSite("self_named.py", 1, "annotation_type"),
      pythonAnnotationSite("self_named.py", 2, "annotation_type", 2),
      pythonAnnotationSite("self_named.py", 2, "annotation_type", 3),
      pythonAnnotationSite("postponed_calls.py", 2, "annotation_type"),
      pythonAnnotationSite("postponed_calls.py", 3, "annotation_type", 2),
      pythonAnnotationSite("postponed_calls.py", 3, "annotation_type", 3),
      pythonAnnotationSite("postponed_calls.py", 5, "annotation_type"),
      pythonAnnotationSite("postponed_calls.py", 7, "annotation_type", 2),
      pythonAnnotationSite("postponed_calls.py", 7, "annotation_type", 3),
      pythonAnnotationSite("postponed_calls.py", 7, "annotation_type", 4),
      pythonAnnotationSite("postponed_calls.py", 10, "annotation_type"),
      pythonAnnotationSite("postponed_calls.py", 10, "annotation_type", 2),
      pythonAnnotationSite("postponed_calls.py", 12, "annotation_type"),
    ],
  },
  {
    label: "annotation callable parameter",
    declaration: pythonAnnotationSite("calls.py", 2, "annotation_type"),
    reads: [pythonAnnotationSite("calls.py", 3, "annotation_type")],
  },
  {
    label: "new function binding",
    declaration: pythonAnnotationSite("self_named.py", 2, "annotation_type"),
    reads: [pythonAnnotationSite("self_named.py", 3, "annotation_type")],
  },
  {
    label: "unimported type decoy",
    declaration: pythonAnnotationSite("decoy.py", 1, "T"),
    reads: [pythonAnnotationSite("decoy.py", 4, "T")],
  },
  {
    label: "earlier type in eager annotations and defaults",
    declaration: pythonAnnotationSite("models.py", 5, "f"),
    reads: [
      pythonAnnotationSite("eager_self.py", 1, "f", 2),
      pythonAnnotationSite("eager_self.py", 2, "f", 3),
      pythonAnnotationSite("eager_self.py", 2, "f", 4),
      pythonAnnotationSite("eager_self.py", 2, "f", 5),
      pythonAnnotationSite("postponed_self.py", 2, "f", 2),
      pythonAnnotationSite("postponed_self.py", 3, "f", 4),
    ],
  },
  {
    label: "eager function binding",
    declaration: pythonAnnotationSite("eager_self.py", 2, "f", 2),
    reads: [pythonAnnotationSite("eager_self.py", 3, "f")],
  },
  {
    label: "postponed function annotation binding",
    declaration: pythonAnnotationSite("postponed_self.py", 3, "f", 2),
    reads: [
      pythonAnnotationSite("postponed_self.py", 3, "f", 3),
      pythonAnnotationSite("postponed_self.py", 3, "f", 5),
      pythonAnnotationSite("postponed_self.py", 4, "f"),
    ],
  },
  {
    label: "outer parameter excluded from postponed annotations",
    declaration: pythonAnnotationSite("postponed_scope.py", 3, "T"),
    reads: [pythonAnnotationSite("postponed_scope.py", 4, "T", 2), pythonAnnotationSite("postponed_scope.py", 5, "T")],
  },
  {
    label: "outer local excluded from postponed annotations",
    declaration: pythonAnnotationSite("postponed_scope.py", 8, "T"),
    reads: [pythonAnnotationSite("postponed_scope.py", 9, "T", 2), pythonAnnotationSite("postponed_scope.py", 10, "T")],
  },
  {
    label: "class local excluded from postponed annotations",
    declaration: pythonAnnotationSite("postponed_scope.py", 13, "T"),
    reads: [pythonAnnotationSite("postponed_scope.py", 14, "T", 2)],
  },
  {
    label: "later local cannot steal postponed annotation sites",
    declaration: pythonAnnotationSite("postponed_scope.py", 21, "T"),
    reads: [pythonAnnotationSite("postponed_scope.py", 20, "T")],
  },
  {
    label: "outer parameter without a module annotation binding",
    declaration: pythonAnnotationSite("postponed_unbound.py", 2, "T"),
    reads: [pythonAnnotationSite("postponed_unbound.py", 4, "T")],
  },
  {
    label: "class local without a module annotation binding",
    declaration: pythonAnnotationSite("postponed_unbound.py", 7, "T"),
    reads: [],
  },
  {
    label: "lazy annotation callable parameter",
    declaration: pythonAnnotationSite("postponed_calls.py", 3, "annotation_type"),
    reads: [pythonAnnotationSite("postponed_calls.py", 4, "annotation_type")],
  },
  {
    label: "combined annotation and default callable parameter",
    declaration: pythonAnnotationSite("postponed_calls.py", 7, "annotation_type"),
    reads: [pythonAnnotationSite("postponed_calls.py", 8, "annotation_type")],
  },
];

export async function assertPythonAnnotationNavigation(
  index: ProjectIndex,
  paths: Readonly<Record<string, string>>,
): Promise<void> {
  for (const binding of PYTHON_ANNOTATION_BINDINGS) {
    for (const site of binding.reads) {
      const result = await goToDefinition(index, { ...site, file: paths[site.file]! });
      const label = `${binding.label}: ${site.file}:${site.line}:${site.column}`;
      expect(result.status, label).toBe("ok");
      if (result.status !== "ok") throw new Error(`Missing annotation target: ${label}`);
      expect(fileIdentityKey(result.definition.file), label).toBe(fileIdentityKey(paths[binding.declaration.file]!));
      expect(result.definition.range.start.line, label).toBe(binding.declaration.line);
      expect(result.definition.range.start.column, label).toBe(binding.declaration.column);
    }
  }
  for (const occurrence of [2, 3]) {
    const site = pythonAnnotationSite("future.py", 5, "T", occurrence);
    const quoted = await goToDefinition(index, { ...site, file: paths[site.file]! });
    expect(quoted.status, `quoted annotation ${occurrence}`).toBe("not_found");
  }
  for (const site of [
    pythonAnnotationSite("postponed_unbound.py", 3, "T"),
    pythonAnnotationSite("postponed_unbound.py", 3, "T", 2),
    pythonAnnotationSite("postponed_unbound.py", 8, "T"),
    pythonAnnotationSite("postponed_unbound.py", 8, "T", 2),
    pythonAnnotationSite("postponed_unbound.py", 9, "T"),
  ]) {
    const unbound = await goToDefinition(index, { ...site, file: paths[site.file]! });
    expect(unbound.status, `unbound postponed annotation ${site.line}:${site.column}`).toBe("not_found");
  }
  const keyword = await goToDefinition(index, { file: paths["future.py"]!, line: 5, column: 1 });
  expect(keyword.status).toBe("ok");
  if (keyword.status !== "ok") throw new Error("Expected the Python declaration keyword");
  expect(fileIdentityKey(keyword.definition.file)).toBe(fileIdentityKey(paths["future.py"]!));
  expect(keyword.definition.range.start.line).toBe(5);
  expect(keyword.definition.range.start.column).toBe(5);
}

export async function assertPythonAnnotationReferences(
  index: ProjectIndex,
  paths: Readonly<Record<string, string>>,
): Promise<void> {
  for (const binding of PYTHON_ANNOTATION_BINDINGS) {
    const declaration = binding.declaration;
    const result = await findReferences(index, { ...declaration, file: paths[declaration.file]! });
    expect(result.status, binding.label).toBe("ok");
    if (result.status !== "ok") throw new Error(`Missing annotation references: ${binding.label}`);
    expect(result.referenceCoverage.state, binding.label).toBe("complete");
    const actual = result.references
      .map((ref) => `${fileIdentityKey(ref.file)}:${ref.range.start.line}:${ref.range.start.column}`)
      .sort();
    const expected = [declaration, ...binding.reads]
      .map((site) => `${fileIdentityKey(paths[site.file]!)}:${site.line}:${site.column}`)
      .sort();
    expect(actual, binding.label).toEqual(expected);
  }
}

export async function assertPythonPostponedCallEdges(
  index: ProjectIndex,
  paths: Readonly<Record<string, string>>,
): Promise<void> {
  const graph = await buildSymbolGraphDetailed(index);
  const actual = graph.edges
    .filter(
      (edge) =>
        edge.label === "calls" &&
        fileIdentityKey(graph.nodes.get(edge.from)?.file ?? "") === fileIdentityKey(paths["postponed_calls.py"]!),
    )
    .map((edge) => [
      graph.nodes.get(edge.from)?.name,
      fileIdentityKey(graph.nodes.get(edge.to)?.file ?? ""),
      graph.nodes.get(edge.to)?.name,
      edge.site?.range.start.line,
      edge.site?.range.start.column,
    ]);
  const eager = pythonAnnotationSite("postponed_calls.py", 5, "annotation_type");
  const combined = pythonAnnotationSite("postponed_calls.py", 7, "annotation_type", 3);
  const namespace = pythonAnnotationSite("postponed_calls.py", 12, "models");
  expect(actual.sort()).toEqual([
    ["combined", fileIdentityKey(paths["models.py"]!), "annotation_type", combined.line, combined.column],
    ["eager", fileIdentityKey(paths["models.py"]!), "annotation_type", eager.line, eager.column],
    ["eager_namespace", fileIdentityKey(paths["models.py"]!), "annotation_type", namespace.line, namespace.column],
  ]);
}
