import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inspectCArchives, nativeArchives } from "./native-cpu-archive-lib.mjs";
import { assertNativeCpuBaseline, scanNativeDisassembly } from "./native-cpu-baseline-lib.mjs";

function command(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${executable} failed (${result.signal ?? result.status}):\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

function rustObjdump() {
  const sysroot = command("rustc", ["--print", "sysroot"]).trim();
  const host = /^host: (.+)$/mu.exec(command("rustc", ["-vV"]))?.[1];
  if (!host) throw new Error("rustc did not report its host triple.");
  const executable = process.platform === "win32" ? "llvm-objdump.exe" : "llvm-objdump";
  const objdump = path.join(sysroot, "lib", "rustlib", host, "bin", executable);
  if (!fs.existsSync(objdump))
    throw new Error("Install the disassembler with rustup component add llvm-tools-preview.");
  return objdump;
}

try {
  const { values } = parseArgs({
    options: {
      addon: { type: "string" },
      "build-dir": { type: "string" },
      objdump: { type: "string" },
      qemu: { type: "boolean", default: false },
    },
  });
  if (!values.addon) {
    throw new Error(
      "Usage: node scripts/check-native-cpu-baseline.mjs --addon FILE [--build-dir DIR] [--objdump FILE] [--qemu]",
    );
  }
  const addon = path.resolve(values.addon);
  const objdump = values.objdump ?? rustObjdump();
  const sectionHeaders = (filename) => command(objdump, ["--section-headers", filename]);
  const disassemble = (filename) => {
    const args = ["-d", "--no-show-raw-insn"];
    const text = command(objdump, [...args, filename]);
    // The format-aware decoder respects Mach-O inline data directives.
    if (!text.includes("file format mach-o")) return text;
    return command(objdump, [...args, "--macho", filename]);
  };
  if (values["build-dir"]) {
    sectionHeaders(addon);
    const archives = nativeArchives(path.resolve(values["build-dir"]));
    if (!archives.length) throw new Error("No C/C++ build archives found; refusing an empty baseline check.");
    const result = inspectCArchives(archives, { sectionHeaders, disassemble });
    // Archives are the complete C attribution evidence, even for stripped or
    // unprefixed code. Named linked symbols cannot substitute for missing/IR members.
    console.log(
      `x86-64 baseline OK: ${result.members} object members (${result.instructions} instructions), ${result.imports} short-import members skipped; every C/C++ member inspected.`,
    );
  } else {
    // Historical packages do not ship their build objects. This bounded diagnostic
    // must not claim the full C coverage required by release/CI --build-dir checks.
    const linked = scanNativeDisassembly(disassemble(addon));
    assertNativeCpuBaseline(linked, path.basename(addon));
    if (!linked.parserFunctions) throw new Error("No named parser functions found.");
    console.log(
      `Named parser-symbol check OK: ${linked.parserFunctions} functions; full C coverage requires --build-dir.`,
    );
  }
  if (values.qemu) {
    if (process.platform !== "linux" || process.arch !== "x64")
      throw new Error("The QEMU smoke requires a Linux x64 host.");
    const smoke = fileURLToPath(new URL("./native-cpu-smoke.cjs", import.meta.url));
    process.stdout.write(command("qemu-x86_64", ["-cpu", "SandyBridge", process.execPath, smoke, addon]));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
