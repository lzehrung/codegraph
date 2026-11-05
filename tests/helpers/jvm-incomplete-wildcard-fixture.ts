import { DEFAULT_NATIVE_SOURCE_MAX_BYTES } from "../../src/native/source-limits.js";

/** Real package files shared by navigation, references, graph, and native-cache regressions. */
export function jvmIncompleteWildcardSources(): Record<string, string> {
  const padding = `//${" ".repeat(DEFAULT_NATIVE_SOURCE_MAX_BYTES)}\n`;
  return {
    "big/Small.kt": "package big\n\nfun select(x: Int) = x\nclass Service(val value: Int)\n",
    "big/Big.kt": `package big\n\nclass Before\n${padding}fun select(x: String) = x\nfun Service(x: String) = Service(0)\n`,
    "gap/Small.kt": "package gap\n\nfun select(x: Int) = x\nclass Service(val value: Int)\n",
    "gap/Gap.kt": "package gap\n\nclass Before\n)\nfun select(x: String) = x\n",
    "overlap/A.kt": "package overlap\n\nfun select(x: Int) = x\n",
    "overlap/B.kt": "package overlap\n\nfun select(x: String) = x\n",
    "single/Only.kt": "package single\n\nfun select(x: Int) = x\n",
    "classes/Only.kt": "package classes\n\nclass Service(val value: Int)\n",
    "shapes/Shape.java": "package shapes;\n\npublic class Shape {}\n",
    "shapes/Gap.kt": "package shapes\n\nclass Before\n)\nfun Shape(x: String) = x\n",
    "decoy/Decoy.kt": "package decoy\n\nfun select(x: Int) = x\nclass Service(val value: Int)\n",
    "app/BigUse.kt": [
      "package bigapp",
      "import big.*",
      'fun useBig() = select("x")',
      'fun makeBig(): Service = Service("x")',
      "fun spreadBig(args: Array<String>) = Service(*args)",
    ].join("\n"),
    "app/GapUse.kt": [
      "package gapapp",
      "import gap.*",
      'fun useGap() = select("x")',
      'fun makeGap(): Service = Service("x")',
      "fun spreadGap(args: Array<String>) = Service(*args)",
    ].join("\n"),
    "app/OverlapUse.kt": "package overlapapp\nimport overlap.*\nfun useOverlap() = select(1)\n",
    "app/SingleUse.kt": "package singleapp\nimport single.*\nfun useSingle() = select(1)\n",
    "app/ClassUse.kt": "package classapp\nimport classes.*\nfun makeClass(): Service = Service(1)\n",
    "app/ShapeUse.java": "package shapeapp;\nimport shapes.*;\nclass JavaUse { Shape value; }\n",
  };
}

export const JVM_INCOMPLETE_WILDCARD_CALLS = [
  { file: "app/BigUse.kt", line: 3, name: "select", caller: "useBig", target: null },
  { file: "app/BigUse.kt", line: 4, name: "Service", caller: "makeBig", target: null },
  { file: "app/BigUse.kt", line: 5, name: "Service", caller: "spreadBig", target: null },
  { file: "app/GapUse.kt", line: 3, name: "select", caller: "useGap", target: null },
  { file: "app/GapUse.kt", line: 4, name: "Service", caller: "makeGap", target: null },
  { file: "app/GapUse.kt", line: 5, name: "Service", caller: "spreadGap", target: null },
  { file: "app/OverlapUse.kt", line: 3, name: "select", caller: "useOverlap", target: null },
  {
    file: "app/SingleUse.kt",
    line: 3,
    name: "select",
    caller: "useSingle",
    target: { file: "single/Only.kt", line: 3 },
  },
  {
    file: "app/ClassUse.kt",
    line: 3,
    name: "Service",
    caller: "makeClass",
    target: { file: "classes/Only.kt", line: 3 },
  },
] as const;

export const JVM_INCOMPLETE_WILDCARD_TYPES = [
  { file: "app/BigUse.kt", line: 4, name: "Service", target: { file: "big/Small.kt", line: 4 } },
  { file: "app/GapUse.kt", line: 4, name: "Service", target: { file: "gap/Small.kt", line: 4 } },
  { file: "app/ClassUse.kt", line: 3, name: "Service", target: { file: "classes/Only.kt", line: 3 } },
  { file: "app/ShapeUse.java", line: 3, name: "Shape", target: { file: "shapes/Shape.java", line: 3 } },
] as const;

export const JVM_INCOMPLETE_WILDCARD_REFERENCES = [
  { file: "big/Small.kt", line: 3, name: "select", consumer: "app/BigUse.kt", lines: [], partial: true },
  { file: "gap/Small.kt", line: 3, name: "select", consumer: "app/GapUse.kt", lines: [], partial: true },
  { file: "big/Small.kt", line: 4, name: "Service", consumer: "app/BigUse.kt", lines: [4], partial: true },
  { file: "gap/Small.kt", line: 4, name: "Service", consumer: "app/GapUse.kt", lines: [4], partial: true },
  { file: "overlap/A.kt", line: 3, name: "select", consumer: "app/OverlapUse.kt", lines: [], partial: false },
  { file: "overlap/B.kt", line: 3, name: "select", consumer: "app/OverlapUse.kt", lines: [], partial: false },
  { file: "single/Only.kt", line: 3, name: "select", consumer: "app/SingleUse.kt", lines: [3], partial: false },
  { file: "classes/Only.kt", line: 3, name: "Service", consumer: "app/ClassUse.kt", lines: [3, 3], partial: false },
  { file: "shapes/Shape.java", line: 3, name: "Shape", consumer: "app/ShapeUse.java", lines: [3], partial: true },
  { file: "decoy/Decoy.kt", line: 3, name: "select", consumer: "app/BigUse.kt", lines: [], partial: false },
] as const;
