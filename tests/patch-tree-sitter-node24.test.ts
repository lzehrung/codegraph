import { describe, expect, it } from "vitest";
import { patchTreeSitterBindingGypSource } from "../scripts/patch-tree-sitter-node24-lib.mjs";

describe("tree-sitter Node 24 patcher", () => {
  it("patches binding.gyp despite CRLF line endings and whitespace drift", () => {
    const source = [
      "{",
      '  "variables": {',
      '    "v8_enable_31bit_smis_on_64bit_arch%" : 0',
      "  },",
      '  "targets": [',
      "    {",
      '      "cflags_cc" : [',
      '        "-std=c++17",',
      "      ],",
      '      "xcode_settings": {',
      '        "CLANG_CXX_LANGUAGE_STANDARD" : "c++17"',
      "      },",
      '      "msvs_settings": {',
      '        "VCCLCompilerTool": { "AdditionalOptions": ["/std:c++17"] }',
      "      },",
      '      "conditions": [',
      '        ["OS==\'linux\'", {',
      '          "cflags_cc" : [',
      '            "-Wno-cast-function-type"',
      "          ]",
      "        }]",
      "      ]",
      "    }",
      "  ]",
      "}",
      "",
    ].join("\r\n");

    const result = patchTreeSitterBindingGypSource(source);

    expect(result.changed).toBe(true);
    expect(result.source).toContain("\r\n");
    expect(result.source).toContain('"cxxstd%": "<!(node -p \\"parseInt');
    expect(result.source).toContain('"CLANG_CXX_LANGUAGE_STANDARD": "<(cxxstd)"');
    expect(result.source).toContain('"/std:<(cxxstd)"');
    expect(result.source).toContain('"-std=<(cxxstd)"');
    expect(result.source).toContain('"-fvisibility=hidden"');
    expect(result.source).toContain('"-Wno-cast-function-type"');
    expect(result.source).not.toContain('"-std=c++17"');
    expect(result.source).not.toContain('"/std:c++17"');
  });

  it("keeps an already patched binding.gyp unchanged", () => {
    const source = '{\n  "variables": {\n    "cxxstd%": "c++20"\n  }\n}\n';

    const result = patchTreeSitterBindingGypSource(source);

    expect(result).toEqual({ source, changed: false });
  });
});
