const CXX_STD_VARIABLE =
  '"cxxstd%": "<!(node -p \\"parseInt(process.env.npm_config_target ?? process.versions.node) < 22 ? \'c++17\' : \'c++20\'\\")"';

function replaceRequired(source, label, pattern, replacement) {
  if (!pattern.test(source)) {
    throw new Error(`Expected tree-sitter binding.gyp fragment was not found: ${label}`);
  }

  return source.replace(pattern, replacement);
}

function restoreLineEndings(source, newline) {
  return newline === "\r\n" ? source.replace(/\n/g, "\r\n") : source;
}

export function patchTreeSitterBindingGypSource(source) {
  if (source.includes('"cxxstd%"')) {
    return { source, changed: false };
  }

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  let patched = source.replace(/\r\n/g, "\n");

  patched = replaceRequired(
    patched,
    'cflags_cc with "-std=c++17"',
    /^[ \t]*"cflags_cc"\s*:\s*\[\s*\n[ \t]*"-std=c\+\+17",?\s*\n[ \t]*\],?\s*\n/m,
    "",
  );

  patched = replaceRequired(
    patched,
    "CLANG_CXX_LANGUAGE_STANDARD",
    /"CLANG_CXX_LANGUAGE_STANDARD"\s*:\s*"c\+\+17"/,
    '"CLANG_CXX_LANGUAGE_STANDARD": "<(cxxstd)"',
  );

  patched = replaceRequired(patched, "/std:c++17", /"\/std:c\+\+17"/, '"/std:<(cxxstd)"');

  patched = replaceRequired(
    patched,
    'cflags_cc with "-Wno-cast-function-type"',
    /^([ \t]*)"cflags_cc"\s*:\s*\[\s*\n([ \t]*)"-Wno-cast-function-type",?\s*\n[ \t]*\],?/m,
    (_match, indent, valueIndent) =>
      [
        `${indent}"cflags_cc": [`,
        `${valueIndent}"-std=<(cxxstd)",`,
        `${valueIndent}"-fvisibility=hidden",`,
        `${valueIndent}"-Wno-cast-function-type",`,
        `${indent}]`,
      ].join("\n"),
  );

  patched = replaceRequired(
    patched,
    "v8_enable_31bit_smis_on_64bit_arch%",
    /^([ \t]*)"v8_enable_31bit_smis_on_64bit_arch%"\s*:\s*0,?\s*$/m,
    (_match, indent) => `${indent}"v8_enable_31bit_smis_on_64bit_arch%": 0,\n${indent}${CXX_STD_VARIABLE},`,
  );

  return { source: restoreLineEndings(patched, newline), changed: true };
}
