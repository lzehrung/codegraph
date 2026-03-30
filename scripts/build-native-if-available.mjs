import { spawnSync } from "node:child_process";

function hasCargo() {
  const result = spawnSync("cargo", ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: "ignore",
  });
  return result.status === 0;
}

if (!hasCargo()) {
  console.warn(
    "[codegraph] Skipping native workspace build because Cargo is unavailable. Install Rust or run a published package install if you need the native addon in this checkout.",
  );
  process.exit(0);
}

const result = spawnSync(
  "npm",
  ["run", "build:native"],
  {
    shell: process.platform === "win32",
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
