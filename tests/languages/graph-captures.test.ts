import { describe, expect, it } from "vitest";
import {
  GRAPH_IMPORT_CAPTURES,
  graphCapture,
  importCapture,
  type GraphImportCapture,
  type GraphImportCaptureExcludesMod,
} from "../../src/languages/graph-captures.js";

describe("GraphImportCapture vocabulary", () => {
  it("is the import-bearing path vocabulary, not the CommonJS identifier @mod", () => {
    expect(GRAPH_IMPORT_CAPTURES).toEqual(["stmt", "from", "alias", "wild", "iname", "def", "ns", "type_kw"]);
    expect(GRAPH_IMPORT_CAPTURES).not.toContain("mod");
    const proof: GraphImportCaptureExcludesMod = true as GraphImportCaptureExcludesMod;
    expect(proof).toBe(true);
    const from = graphCapture("from");
    expect(from).toBe("@from");
    expect(importCapture({ from: "os" }, "from")).toBe("os");
  });

  it("rejects unknown capture names at the type level", () => {
    type Invalid = "mod" extends GraphImportCapture ? true : false;
    const invalid: Invalid = false;
    expect(invalid).toBe(false);
    // @ts-expect-error "mod" is the CommonJS identifier-equality capture, not a path
    graphCapture("mod");
    // @ts-expect-error unknown import capture
    importCapture({}, "module_path");
  });
});
