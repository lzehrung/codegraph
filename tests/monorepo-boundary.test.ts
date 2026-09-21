import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { clearImportResolutionCaches, resolveImportSpecifier, resolvePythonModule } from "../src/util.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { resolveCsharpNamespaceImportPaths } from "../src/util/resolution/csharp.js";
import {
  CSHARP_PACKAGE_MANIFEST_NAMES,
  findNearestManifest,
  resolveNearestManifestRoot,
} from "../src/util/resolution/files.js";
import { resolveJavaImportPath, resolveKotlinImportPath } from "../src/util/resolution/jvm.js";
import { resolvePhpImportPath } from "../src/util/resolution/php.js";
import { createTestIndexFromFiles } from "./test-utils.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function posix(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

async function writeFile(filePath: string, contents: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, contents, "utf8");
}

afterEach(() => {
  clearImportResolutionCaches();
});

describe("monorepo resolution boundaries", () => {
  it("binds a Java package to the nearest Maven module, not a sibling", async () => {
    const root = await mkTmpDir("dg-mono-java-");
    const pkgA = path.join(root, "packages", "a");
    const pkgB = path.join(root, "packages", "b");
    const serviceA = path.join(pkgA, "src", "com", "example", "Service.java");
    const serviceB = path.join(pkgB, "src", "com", "example", "Service.java");
    const appA = path.join(pkgA, "src", "com", "example", "App.java");

    await writeFile(path.join(pkgA, "pom.xml"), "<project></project>\n");
    await writeFile(path.join(pkgB, "pom.xml"), "<project></project>\n");
    await writeFile(serviceA, 'package com.example;\npublic class Service { public static String id = "a"; }\n');
    await writeFile(serviceB, 'package com.example;\npublic class Service { public static String id = "b"; }\n');
    await writeFile(appA, "package com.example;\nimport com.example.Service;\npublic class App { Service s; }\n");

    const local = await resolveJavaImportPath(root, "com.example.Service", appA);
    expect(posix(local ?? "")).toBe(posix(serviceA));
    expect(posix(local ?? "")).not.toBe(posix(serviceB));

    const viaSpecifier = await resolveImportSpecifier(root, appA, "com.example.Service", "java");
    expect(posix(String(viaSpecifier))).toBe(posix(serviceA));
  });

  it("binds a Kotlin package to the nearest Gradle module, not a sibling", async () => {
    const root = await mkTmpDir("dg-mono-kotlin-");
    const pkgA = path.join(root, "packages", "a");
    const pkgB = path.join(root, "packages", "b");
    const serviceA = path.join(pkgA, "src", "com", "example", "Service.kt");
    const serviceB = path.join(pkgB, "src", "com", "example", "Service.kt");
    const appA = path.join(pkgA, "src", "com", "example", "App.kt");

    await writeFile(path.join(pkgA, "build.gradle.kts"), 'plugins { kotlin("jvm") }\n');
    await writeFile(path.join(pkgB, "build.gradle.kts"), 'plugins { kotlin("jvm") }\n');
    await writeFile(serviceA, "package com.example\nclass Service\n");
    await writeFile(serviceB, "package com.example\nclass Service\n");
    await writeFile(appA, "package com.example\nimport com.example.Service\n");

    const local = await resolveKotlinImportPath(root, "com.example.Service", appA);
    expect(posix(local ?? "")).toBe(posix(serviceA));
    expect(posix(local ?? "")).not.toBe(posix(serviceB));
  });

  it("binds a C# namespace to the nearest csproj, not a sibling", async () => {
    const root = await mkTmpDir("dg-mono-csharp-");
    const pkgA = path.join(root, "packages", "a");
    const pkgB = path.join(root, "packages", "b");
    const libA = path.join(pkgA, "Lib.cs");
    const libB = path.join(pkgB, "Lib.cs");
    const appA = path.join(pkgA, "App.cs");

    await writeFile(path.join(pkgA, "A.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
    await writeFile(path.join(pkgB, "B.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
    await writeFile(libA, "namespace Shared;\npublic class Lib {}\n");
    await writeFile(libB, "namespace Shared;\npublic class Lib {}\n");
    await writeFile(appA, "using Shared;\npublic class App { Shared.Lib lib; }\n");

    const local = await resolveCsharpNamespaceImportPaths(root, "Shared", appA);
    expect(local.map(posix)).toEqual([posix(libA)]);
    expect(local.map(posix)).not.toContain(posix(libB));

    const fromB = await resolveCsharpNamespaceImportPaths(root, "Shared", libB);
    expect(fromB.map(posix)).toEqual([posix(libB)]);
  });

  it("skips a directory named like a csproj and still binds to a real sibling csproj", async () => {
    const root = await mkTmpDir("dg-mono-csharp-csproj-dir-");
    const pkgA = path.join(root, "packages", "a");
    const pkgB = path.join(root, "packages", "b");
    const libA = path.join(pkgA, "Lib.cs");
    const libB = path.join(pkgB, "Lib.cs");
    const appA = path.join(pkgA, "src", "App.cs");
    const realProj = path.join(pkgA, "Thing.csproj");

    await fsp.mkdir(path.join(pkgA, "build.csproj"), { recursive: true });
    await fsp.mkdir(path.join(pkgA, "src", "obj.csproj"), { recursive: true });
    await writeFile(realProj, '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
    await writeFile(path.join(pkgB, "B.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
    await writeFile(libA, "namespace Shared;\npublic class Lib {}\n");
    await writeFile(libB, "namespace Shared;\npublic class Lib {}\n");
    await writeFile(appA, "using Shared;\npublic class App { Shared.Lib lib; }\n");

    const fromSrc = await findNearestManifest(path.dirname(appA), root, CSHARP_PACKAGE_MANIFEST_NAMES);
    expect(posix(fromSrc ?? "")).toBe(posix(realProj));
    const beside = await findNearestManifest(pkgA, root, CSHARP_PACKAGE_MANIFEST_NAMES);
    expect(posix(beside ?? "")).toBe(posix(realProj));
    expect(posix(await resolveNearestManifestRoot(root, appA, CSHARP_PACKAGE_MANIFEST_NAMES))).toBe(posix(pkgA));

    const local = await resolveCsharpNamespaceImportPaths(root, "Shared", appA);
    expect(local.map(posix)).toEqual([posix(libA)]);
    expect(local.map(posix)).not.toContain(posix(libB));
  });

  it("falls back to the project root when the only *.csproj match is a directory", async () => {
    const root = await mkTmpDir("dg-mono-csharp-csproj-dir-fallback-");
    const pkgA = path.join(root, "packages", "a");
    const pkgB = path.join(root, "packages", "b");
    const libA = path.join(pkgA, "Lib.cs");
    const libB = path.join(pkgB, "Lib.cs");
    const appA = path.join(pkgA, "App.cs");

    await fsp.mkdir(path.join(pkgA, "build.csproj"), { recursive: true });
    await writeFile(libA, "namespace Shared;\npublic class Lib {}\n");
    await writeFile(libB, "namespace Shared;\npublic class Lib {}\n");
    await writeFile(appA, "using Shared;\npublic class App { Shared.Lib lib; }\n");

    await expect(findNearestManifest(pkgA, root, CSHARP_PACKAGE_MANIFEST_NAMES)).resolves.toBeNull();
    expect(posix(await resolveNearestManifestRoot(root, appA, CSHARP_PACKAGE_MANIFEST_NAMES))).toBe(posix(root));

    const local = await resolveCsharpNamespaceImportPaths(root, "Shared", appA);
    expect(local.map(posix).sort()).toEqual([posix(libA), posix(libB)].sort());
  });

  it("selects the same *.csproj regardless of directory creation order", async () => {
    const manifest = '<Project Sdk="Microsoft.NET.Sdk"></Project>\n';
    const first = await mkTmpDir("dg-mono-csharp-order-first-");
    const second = await mkTmpDir("dg-mono-csharp-order-second-");
    const firstProject = path.join(first, "App");
    const secondProject = path.join(second, "App");

    await writeFile(path.join(firstProject, "App.csproj"), manifest);
    await writeFile(path.join(firstProject, "App.Core.csproj"), manifest);
    await writeFile(path.join(secondProject, "App.Core.csproj"), manifest);
    await writeFile(path.join(secondProject, "App.csproj"), manifest);

    const firstChoice = await findNearestManifest(firstProject, first, CSHARP_PACKAGE_MANIFEST_NAMES);
    const secondChoice = await findNearestManifest(secondProject, second, CSHARP_PACKAGE_MANIFEST_NAMES);

    // The directory-named manifest wins in both trees, so a cached package root cannot depend
    // on `readdir` order or on which file happened to be written first.
    expect(posix(firstChoice ?? "")).toBe(posix(path.join(firstProject, "App.csproj")));
    expect(posix(secondChoice ?? "")).toBe(posix(path.join(secondProject, "App.csproj")));
  });

  it("binds a PHP namespace to the nearest composer.json, not a sibling", async () => {
    const root = await mkTmpDir("dg-mono-php-");
    const pkgA = path.join(root, "packages", "a");
    const pkgB = path.join(root, "packages", "b");
    const serviceA = path.join(pkgA, "src", "Service.php");
    const serviceB = path.join(pkgB, "src", "Service.php");
    const consumerA = path.join(pkgA, "consumer.php");

    await writeFile(path.join(pkgA, "composer.json"), JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } }));
    await writeFile(path.join(pkgB, "composer.json"), JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } }));
    await writeFile(serviceA, "<?php\nnamespace App;\nclass Service {}\n");
    await writeFile(serviceB, "<?php\nnamespace App;\nclass Service {}\n");
    await writeFile(consumerA, "<?php\nuse App\\Service;\n");

    const local = await resolvePhpImportPath(root, consumerA, "App\\Service");
    expect(posix(local ?? "")).toBe(posix(serviceA));
    expect(posix(local ?? "")).not.toBe(posix(serviceB));

    const viaSpecifier = await resolveImportSpecifier(root, consumerA, "App\\Service", "php");
    expect(posix(String(viaSpecifier))).toBe(posix(serviceA));
  });

  it("binds a Python module to the nearest pyproject, not a same-named root or sibling", async () => {
    const root = await mkTmpDir("dg-mono-python-");
    const pkgA = path.join(root, "packages", "a");
    const pkgB = path.join(root, "packages", "b");
    const rootFoo = path.join(root, "foo.py");
    const fooA = path.join(pkgA, "foo.py");
    const fooB = path.join(pkgB, "foo.py");
    const appA = path.join(pkgA, "app.py");

    await writeFile(path.join(pkgA, "pyproject.toml"), '[project]\nname = "a"\nversion = "0.0.1"\n');
    await writeFile(path.join(pkgB, "pyproject.toml"), '[project]\nname = "b"\nversion = "0.0.1"\n');
    await writeFile(rootFoo, "VALUE = 'root'\n");
    await writeFile(fooA, "VALUE = 'a'\n");
    await writeFile(fooB, "VALUE = 'b'\n");
    await writeFile(appA, "import foo\n");

    const local = await resolvePythonModule(root, appA, "foo", 0);
    expect(posix(String(local))).toBe(posix(fooA));
    expect(posix(String(local))).not.toBe(posix(fooB));
    expect(posix(String(local))).not.toBe(posix(rootFoo));
  });

  it("falls back to the project root when no language manifest exists", async () => {
    const root = await mkTmpDir("dg-mono-java-fallback-");
    const service = path.join(root, "src", "com", "example", "Service.java");
    const app = path.join(root, "src", "com", "example", "App.java");
    await writeFile(service, "package com.example;\npublic class Service {}\n");
    await writeFile(app, "package com.example;\nimport com.example.Service;\npublic class App {}\n");

    const resolved = await resolveJavaImportPath(root, "com.example.Service", app);
    expect(posix(resolved ?? "")).toBe(posix(service));
  });

  it("indexes a mixed-language monorepo so local JVM and C# packages win graph edges", async () => {
    const root = await mkTmpDir("dg-mono-graph-");
    const javaA = path.join(root, "packages", "java-a");
    const javaB = path.join(root, "packages", "java-b");
    const csA = path.join(root, "packages", "cs-a");
    const csB = path.join(root, "packages", "cs-b");
    const javaServiceA = path.join(javaA, "src", "com", "example", "Service.java");
    const javaServiceB = path.join(javaB, "src", "com", "example", "Service.java");
    const javaAppA = path.join(javaA, "src", "com", "example", "App.java");
    const csLibA = path.join(csA, "Lib.cs");
    const csLibB = path.join(csB, "Lib.cs");
    const csAppA = path.join(csA, "App.cs");

    await writeFile(path.join(javaA, "pom.xml"), "<project></project>\n");
    await writeFile(path.join(javaB, "pom.xml"), "<project></project>\n");
    await writeFile(path.join(csA, "A.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
    await writeFile(path.join(csB, "B.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
    await writeFile(javaServiceA, 'package com.example;\npublic class Service { public static String id = "a"; }\n');
    await writeFile(javaServiceB, 'package com.example;\npublic class Service { public static String id = "b"; }\n');
    await writeFile(javaAppA, "package com.example;\nimport com.example.Service;\npublic class App { Service s; }\n");
    await writeFile(csLibA, "namespace Shared;\npublic class Lib {}\n");
    await writeFile(csLibB, "namespace Shared;\npublic class Lib {}\n");
    await writeFile(csAppA, "using Shared;\npublic class App { Shared.Lib lib; }\n");

    const index = await createTestIndexFromFiles(root, [javaAppA, javaServiceA, javaServiceB, csAppA, csLibA, csLibB]);

    const fileTargetsFrom = (file: string): string[] =>
      index.graph.edges
        .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(file) && edge.to.type === "file")
        .map((edge) => (edge.to.type === "file" ? posix(edge.to.path) : ""));

    const javaTargets = fileTargetsFrom(javaAppA);
    expect(javaTargets).toContain(posix(javaServiceA));
    expect(javaTargets).not.toContain(posix(javaServiceB));

    const csharpTargets = fileTargetsFrom(csAppA);
    expect(csharpTargets).toContain(posix(csLibA));
    expect(csharpTargets).not.toContain(posix(csLibB));
  });
});
