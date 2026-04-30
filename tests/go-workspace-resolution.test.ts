import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";

import { resolveGoImportPath } from "../src/util.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("go.work multi-module import resolution", () => {
  it("resolves imports across modules listed in go.work", async () => {
    const root = await mkTmpDir("dg-go-work-");
    const appDir = path.join(root, "app");
    const libDir = path.join(root, "lib");

    await fsp.mkdir(path.join(appDir, "cmd"), { recursive: true });
    await fsp.mkdir(path.join(libDir, "pkg", "greet"), { recursive: true });

    await fsp.writeFile(path.join(root, "go.work"), ["go 1.22", "", "use (", "  ./app", "  ./lib", ")", ""].join("\n"), "utf8");

    await fsp.writeFile(path.join(appDir, "go.mod"), ["module example.com/app", "", "go 1.22", ""].join("\n"), "utf8");

    await fsp.writeFile(path.join(libDir, "go.mod"), ["module example.com/lib", "", "go 1.22", ""].join("\n"), "utf8");

    const mainFile = path.join(appDir, "cmd", "main.go");
    await fsp.writeFile(
      mainFile,
      ["package main", "", 'import "example.com/lib/pkg/greet"', "", "func main() { greet.Hello() }", ""].join("\n"),
      "utf8",
    );

    const greetFile = path.join(libDir, "pkg", "greet", "greet.go");
    await fsp.writeFile(greetFile, ["package greet", "", "func Hello() {}", ""].join("\n"), "utf8");

    const resolved = await resolveGoImportPath(root, mainFile, "example.com/lib/pkg/greet");
    expect(resolved).toBe(greetFile);
  });
});
