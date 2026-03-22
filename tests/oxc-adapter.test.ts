import { describe, expect, it } from "vitest";

import { analyzeJsTsModuleWithOxc } from "../src/languages/oxcAdapter.js";

describe("Oxc adapter", () => {
  it("extracts local exports and reexports from TypeScript", () => {
    const source = [
      "export function helper() { return 1; }",
      "export class Box {}",
      "export const VALUE = 1;",
      "export type Shape = { x: number };",
      "export { helper as helperAlias };",
      "export { other as otherAlias } from './other';",
      "export * as ns from './ns';",
      "export * from './all';",
      "declare module 'react' {}",
    ].join("\n");

    const result = analyzeJsTsModuleWithOxc("sample.ts", source, "ts");
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.locals.map((entry) => entry.localName)).toEqual(
      expect.arrayContaining(["helper", "Box", "VALUE", "Shape"]),
    );
    expect(
      result.exports.filter((entry) => entry.type === "local").map((entry) => entry.exportedAs),
    ).toEqual(expect.arrayContaining(["helper", "Box", "VALUE", "Shape", "helperAlias"]));
    expect(result.exports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reexport",
          exportedAs: "otherAlias",
          fromModule: "./other",
          sourceSpecifier: "other",
        }),
        expect.objectContaining({
          type: "namespaceReexport",
          exportedAs: "ns",
          fromModule: "./ns",
        }),
        expect.objectContaining({
          type: "exportStar",
          fromModule: "./all",
        }),
      ]),
    );
    expect(result.specifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ spec: "./other", typeOnly: false }),
        expect.objectContaining({ spec: "./ns", typeOnly: false }),
        expect.objectContaining({ spec: "./all", typeOnly: false }),
        expect.objectContaining({ spec: "react", typeOnly: true }),
      ]),
    );
  });

  it("extracts CommonJS imports without promoting require bindings to locals", () => {
    const source = [
      "const { helperFunction: requireHelper } = require('./helpers');",
      "const moduleAlias = require('./module');",
      "exports.run = () => requireHelper();",
    ].join("\n");

    const result = analyzeJsTsModuleWithOxc("sample.js", source, "js");
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "named",
          local: "requireHelper",
          imported: "helperFunction",
          from: "./helpers",
          mechanism: "cjs",
        }),
        expect.objectContaining({
          kind: "default",
          local: "moduleAlias",
          from: "./module",
          mechanism: "cjs",
        }),
      ]),
    );
    expect(result.locals.map((entry) => entry.localName)).not.toContain("requireHelper");
    expect(result.locals.map((entry) => entry.localName)).not.toContain("moduleAlias");
  });

  it("creates a synthetic default symbol for anonymous default exports", () => {
    const source = "export default () => 42;";
    const result = analyzeJsTsModuleWithOxc("sample.ts", source, "ts");
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.exports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "local",
          exportedAs: "default",
          target: expect.objectContaining({
            localName: "__default_export__",
            kind: "default",
          }),
        }),
      ]),
    );
  });

  it("does not treat trailing comments as docstrings for the next symbol", () => {
    const source = [
      "const value = 1; // not docs",
      "export function next() { return value; }",
    ].join("\n");

    const result = analyzeJsTsModuleWithOxc("sample.ts", source, "ts");
    expect(result).not.toBeNull();
    if (!result) return;

    const nextSymbol = result.locals.find((entry) => entry.localName === "next");
    expect(nextSymbol).toBeDefined();
    expect(nextSymbol?.docstring).toBeUndefined();
  });
});
