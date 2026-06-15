import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeCoverageMarkdownReports } from "./coverage-markdown-lib.mjs";

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

function commandOutput(command, args) {
  const result = spawnSync(executable(command), args, {
    cwd: rootDir,
    stdio: "pipe",
    encoding: "utf8",
    shell: usesShell(command),
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }

  return result.stdout;
}

function ensureNativeCoverageTool() {
  if (commandSucceeds("cargo", ["llvm-cov", "--version"])) {
    return;
  }

  console.error("Missing native coverage tool: cargo llvm-cov");
  console.error("Install it with: npm run coverage:setup:native");
  process.exit(1);
}

function rustHostTarget() {
  const output = commandOutput("rustc", ["-vV"]);
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("host: ")) {
      return line.slice("host: ".length);
    }
  }

  console.error("Unable to determine Rust host target from `rustc -vV`.");
  process.exit(1);
}

function coverageLink(pathname, label) {
  if (!fs.existsSync(path.join(coverageDir, pathname))) {
    return "";
  }

  return `      <a href="./${pathname}">${label}</a>\n`;
}

function coverageSection(pathname, heading, title) {
  if (!fs.existsSync(path.join(coverageDir, pathname))) {
    return "";
  }

  return `    <section>
      <h2>${heading}</h2>
      <iframe src="./${pathname}" title="${title}"></iframe>
    </section>
`;
}

function writeCoverageIndex() {
  fs.mkdirSync(coverageDir, { recursive: true });
  const navLinks = [
    coverageLink("js/index.html", "JavaScript/TypeScript HTML"),
    coverageLink("native/html/index.html", "Rust native HTML"),
    coverageLink("js/lcov.info", "JavaScript LCOV"),
    coverageLink("native/lcov.info", "Rust LCOV"),
  ].join("");
  const sections = [
    coverageSection("js/index.html", "JavaScript/TypeScript", "JavaScript and TypeScript coverage"),
    coverageSection("native/html/index.html", "Rust native", "Rust native coverage"),
  ].join("");
  const mainContent = sections.length
    ? sections
    : "    <section>\n      <h2>Coverage</h2>\n      <p>No HTML coverage reports have been generated.</p>\n    </section>\n";

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
    p { margin: 12px; font-size: 14px; }
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
${navLinks.trimEnd()}
    </nav>
  </header>
  <main>
${mainContent.trimEnd()}
  </main>
</body>
</html>
`,
    "utf8",
  );
}

function runJavaScriptCoverage() {
  run(process.execPath, ["./scripts/ensure-dist-for-tests.mjs"]);
  run("npx", ["vitest", "run", "--coverage", "--exclude", "tests/bench-harness.test.ts", "--maxWorkers", "4"]);
}

function runNativeCoverage() {
  ensureNativeCoverageTool();
  const target = rustHostTarget();
  fs.mkdirSync(nativeCoverageDir, { recursive: true });
  run("cargo", ["llvm-cov", "clean", "--manifest-path", "packages/codegraph-native/Cargo.toml"]);
  run("cargo", [
    "llvm-cov",
    "--manifest-path",
    "packages/codegraph-native/Cargo.toml",
    "--target",
    target,
    "--coverage-target-only",
    "--lcov",
    "--output-path",
    "coverage/native/lcov.info",
  ]);
}

const mode = process.argv[2] ?? "all";

if (mode === "js") {
  runJavaScriptCoverage();
  writeCoverageIndex();
  writeCoverageMarkdownReports({ rootDir, mode });
} else if (mode === "native") {
  runNativeCoverage();
  writeCoverageIndex();
  writeCoverageMarkdownReports({ rootDir, mode });
} else if (mode === "all") {
  fs.rmSync(coverageDir, { recursive: true, force: true });
  runJavaScriptCoverage();
  runNativeCoverage();
  writeCoverageIndex();
  writeCoverageMarkdownReports({ rootDir, mode });
} else {
  console.error("Usage: node ./scripts/coverage.mjs [js|native|all]");
  process.exit(1);
}
