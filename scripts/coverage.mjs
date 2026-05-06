import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const coverageDir = path.join(rootDir, "coverage");
const nativeCoverageDir = path.join(coverageDir, "native");

function executable(command) {
  return command;
}

function usesShell(command) {
  return process.platform === "win32" && command !== process.execPath;
}

function run(command, args, options = {}) {
  const result = spawnSync(executable(command), args, {
    cwd: rootDir,
    stdio: options.stdio ?? "inherit",
    encoding: "utf8",
    shell: usesShell(command),
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function commandSucceeds(command, args) {
  const result = spawnSync(executable(command), args, {
    cwd: rootDir,
    stdio: "pipe",
    encoding: "utf8",
    shell: usesShell(command),
  });
  return result.status === 0;
}

function ensureNativeCoverageTool() {
  if (commandSucceeds("cargo", ["llvm-cov", "--version"])) {
    return;
  }

  console.error("Missing native coverage tool: cargo llvm-cov");
  console.error("Install it with: npm run coverage:setup:native");
  process.exit(1);
}

function writeCoverageIndex() {
  fs.mkdirSync(coverageDir, { recursive: true });
  fs.writeFileSync(
    path.join(coverageDir, "index.html"),
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codegraph Coverage</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; color: #111827; background: #f9fafb; }
    header { padding: 16px 20px; border-bottom: 1px solid #d1d5db; background: #ffffff; }
    h1 { margin: 0 0 8px; font-size: 20px; }
    nav { display: flex; gap: 16px; font-size: 14px; flex-wrap: wrap; }
    a { color: #0f766e; }
    main { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); min-height: calc(100vh - 77px); }
    section { min-width: 0; border-right: 1px solid #d1d5db; background: #ffffff; }
    section:last-child { border-right: 0; }
    h2 { margin: 0; padding: 10px 12px; font-size: 14px; border-bottom: 1px solid #e5e7eb; }
    iframe { width: 100%; height: calc(100vh - 118px); border: 0; display: block; background: #ffffff; }
    @media (max-width: 960px) {
      main { grid-template-columns: 1fr; }
      section { border-right: 0; border-bottom: 1px solid #d1d5db; }
      iframe { height: 70vh; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Codegraph Coverage</h1>
    <nav>
      <a href="./js/index.html">JavaScript/TypeScript report</a>
      <a href="./native/html/index.html">Rust native report</a>
      <a href="./js/lcov.info">JavaScript LCOV</a>
      <a href="./native/lcov.info">Rust LCOV</a>
    </nav>
  </header>
  <main>
    <section>
      <h2>JavaScript/TypeScript</h2>
      <iframe src="./js/index.html" title="JavaScript and TypeScript coverage"></iframe>
    </section>
    <section>
      <h2>Rust native</h2>
      <iframe src="./native/html/index.html" title="Rust native coverage"></iframe>
    </section>
  </main>
</body>
</html>
`,
    "utf8",
  );
}

function runJavaScriptCoverage() {
  run(process.execPath, ["./scripts/ensure-dist-for-tests.mjs"]);
  run("npx", ["vitest", "run", "--coverage"]);
}

function runNativeCoverage() {
  ensureNativeCoverageTool();
  fs.mkdirSync(nativeCoverageDir, { recursive: true });
  run("cargo", [
    "llvm-cov",
    "--manifest-path",
    "packages/codegraph-native/Cargo.toml",
    "--html",
    "--output-dir",
    "coverage/native",
  ]);
  run("cargo", [
    "llvm-cov",
    "report",
    "--manifest-path",
    "packages/codegraph-native/Cargo.toml",
    "--lcov",
    "--output-path",
    "coverage/native/lcov.info",
  ]);
}

const mode = process.argv[2] ?? "all";

if (mode === "js") {
  runJavaScriptCoverage();
  writeCoverageIndex();
} else if (mode === "native") {
  runNativeCoverage();
  writeCoverageIndex();
} else if (mode === "all") {
  fs.rmSync(coverageDir, { recursive: true, force: true });
  runJavaScriptCoverage();
  runNativeCoverage();
  writeCoverageIndex();
} else {
  console.error("Usage: node ./scripts/coverage.mjs [js|native|all]");
  process.exit(1);
}
