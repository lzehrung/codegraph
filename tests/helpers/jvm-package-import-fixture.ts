/** Shared consumer cases for authoritative JVM package misses and nested-type path fallback. */
type JvmPackageImportCase = {
  file: string;
  specifier: string;
  name: string;
  target: { file: string; line: number } | null;
  use?: string;
};

export const JVM_PACKAGE_IMPORT_CASES: readonly JvmPackageImportCase[] = [
  {
    file: "app/JavaFunction.java",
    specifier: "com.acme.p6.Hidden",
    name: "Hidden",
    target: null,
  },
  {
    file: "app/JavaOther.java",
    specifier: "com.acme.p7.Hidden",
    name: "Hidden",
    target: null,
  },
  {
    file: "app/JavaEmpty.java",
    specifier: "com.acme.p8.Hidden",
    name: "Hidden",
    target: null,
  },
  {
    file: "app/JavaWrongType.java",
    specifier: "com.acme.p9.Hidden",
    name: "Hidden",
    target: null,
  },
  {
    file: "app/JavaNamed.java",
    specifier: "com.acme.p10.Hidden",
    name: "Hidden",
    target: { file: "com/acme/p10/Hidden.kt", line: 3 },
  },
  {
    file: "app/JavaRenamed.java",
    specifier: "com.acme.p11.Hidden",
    name: "Hidden",
    target: { file: "com/acme/p11/Types.kt", line: 3 },
  },
  {
    file: "app/JavaNested.java",
    specifier: "com.acme.p12.Outer.Inner",
    name: "Inner",
    target: { file: "com/acme/p12/Outer.java", line: 3 },
  },
  {
    file: "app/KotlinFunction.kt",
    specifier: "com.acme.p6.Hidden",
    name: "Hidden",
    target: { file: "com/acme/p6/Hidden.kt", line: 3 },
    use: "fun kotlinFunction(): Int = Hidden()",
  },
  {
    file: "app/KotlinOther.kt",
    specifier: "com.acme.p7.Hidden",
    name: "Hidden",
    target: null,
  },
  {
    file: "app/KotlinEmpty.kt",
    specifier: "com.acme.p8.Hidden",
    name: "Hidden",
    target: null,
  },
  {
    file: "app/KotlinNamed.kt",
    specifier: "com.acme.p10.Hidden",
    name: "Hidden",
    target: { file: "com/acme/p10/Hidden.kt", line: 3 },
  },
  {
    file: "app/KotlinRenamed.kt",
    specifier: "com.acme.p11.Hidden",
    name: "Hidden",
    target: { file: "com/acme/p11/Types.kt", line: 3 },
  },
];

export const JVM_PACKAGE_IMPORT_SOURCES: Record<string, string> = {
  "com/acme/p6/Hidden.kt": "package com.acme.p6\n\nfun Hidden(): Int = 1\n",
  "com/acme/p12/Outer.java": "package com.acme.p12;\n\npublic class Outer { public static class Inner {} }\n",
  "com/acme/p7/Hidden.kt": "package com.acme.p7\n\nclass Other\n",
  "com/acme/p8/Hidden.java": "package com.acme.p8;\n// class Hidden {}\n",
  "com/acme/p9/Hidden.java": "package com.acme.p9;\n\nclass Other {}\n",
  "com/acme/p10/Hidden.kt": "package com.acme.p10\n\nclass Hidden\n",
  "com/acme/p11/Types.kt": "package com.acme.p11\n\nclass Hidden\n",
};

for (const row of JVM_PACKAGE_IMPORT_CASES) {
  const className = row.file.slice(row.file.lastIndexOf("/") + 1, row.file.lastIndexOf("."));
  const java = row.file.endsWith(".java");
  let use = row.use;
  if (!use) {
    use = java ? `class ${className} { ${row.name} value; }` : `class ${className}(val value: ${row.name})`;
  }
  const semicolon = java ? ";" : "";
  JVM_PACKAGE_IMPORT_SOURCES[row.file] = `package app${semicolon}\nimport ${row.specifier}${semicolon}\n${use}\n`;
}
