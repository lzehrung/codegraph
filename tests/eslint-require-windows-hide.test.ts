import { RuleTester } from "eslint";
import { requireWindowsHide } from "../scripts/eslint-rules/require-windows-hide.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester();

const missingOptions = (name: string) => ({ messageId: "missingOptions", data: { name } });
const missingWindowsHide = (name: string) => ({ messageId: "missingWindowsHide", data: { name } });

describe("require-windows-hide ESLint rule", () => {
  tester.run("require-windows-hide", requireWindowsHide, {
    valid: [
      { code: 'import { spawn } from "node:child_process"; spawn("git", ["status"], { windowsHide: true });' },
      { code: 'import { spawnSync } from "child_process"; spawnSync("git", { cwd: ".", windowsHide: true });' },
      { code: 'import { exec } from "node:child_process"; exec("git status", { windowsHide: true }, () => {});' },
      { code: 'import { fork } from "node:child_process"; fork("worker.js", [], { windowsHide: true });' },
      {
        code: 'import { execSync } from "node:child_process"; execSync("git status", { ...base, windowsHide: true });',
      },
      { code: 'import { spawn } from "node:child_process"; spawn("git", [], { "windowsHide": !debug });' },
      {
        code: 'import { execFile as run } from "node:child_process"; run("git", ["status"], { windowsHide: true }, cb);',
      },
      {
        code: 'import * as cp from "node:child_process"; cp.spawnSync("git", [], { windowsHide: true });',
      },
      {
        code: 'import childProcess from "node:child_process"; childProcess.execFileSync("git", [], { windowsHide: true });',
      },
      {
        code: [
          'import { execFile } from "node:child_process";',
          'import { promisify } from "node:util";',
          "const execFileAsync = promisify(execFile);",
          'await execFileAsync("git", ["status"], { windowsHide: true });',
        ].join("\n"),
      },
      {
        code: 'const { spawnSync } = require("node:child_process"); spawnSync("git", [], { windowsHide: true });',
        languageOptions: { sourceType: "commonjs" },
      },
      {
        code: 'const cp = await import("node:child_process"); cp.spawn("git", [], { windowsHide: true });',
      },
      // Same method names that do not come from child_process are not launches.
      { code: "const match = /a/.exec(text); registry.spawn('x'); database.exec('select 1');" },
      { code: 'import { exec } from "./local.js"; exec("select 1");' },
      { code: 'import { Worker } from "node:worker_threads"; new Worker("worker.js", { workerData: 1 });' },
      { code: 'import { fork, spawn } from "node:worker_threads"; fork("a"); spawn("b");' },
      { code: 'import { spawn } from "other-process"; spawn("git", ["status"]);' },
    ],
    invalid: [
      {
        code: 'import { spawn } from "node:child_process"; spawn("git", ["status"]);',
        errors: [missingOptions("spawn")],
      },
      {
        code: 'import { spawnSync } from "child_process"; spawnSync("git");',
        errors: [missingOptions("spawnSync")],
      },
      {
        code: 'import { execFileSync } from "node:child_process"; execFileSync("git", ["status"], { cwd: "." });',
        errors: [missingWindowsHide("execFileSync")],
      },
      {
        code: 'import { exec } from "node:child_process"; exec("git status", {}, () => {});',
        errors: [missingWindowsHide("exec")],
      },
      {
        code: 'import { fork } from "node:child_process"; fork("worker.js", { silent: true });',
        errors: [missingWindowsHide("fork")],
      },
      {
        code: 'import { spawn } from "node:child_process"; spawn("git", [], { windowsHide: false });',
        errors: [{ messageId: "windowsHideFalse", data: { name: "spawn" } }],
      },
      {
        code: 'import { spawn } from "node:child_process"; spawn("git", [], { [key]: true });',
        errors: [missingWindowsHide("spawn")],
      },
      {
        // Options must be visible inline: an identifier or spread cannot be verified.
        code: 'import { spawn } from "node:child_process"; spawn("git", [], options);',
        errors: [missingOptions("spawn")],
      },
      {
        code: 'import { spawn } from "node:child_process"; spawn("git", [], { ...options });',
        errors: [missingWindowsHide("spawn")],
      },
      {
        code: 'import { spawn } from "node:child_process"; spawn(...args);',
        errors: [missingOptions("spawn")],
      },
      {
        code: 'import { execSync } from "node:child_process"; execSync("git status");',
        errors: [missingOptions("execSync")],
      },
      {
        code: 'import { execFile as run } from "node:child_process"; run("git", ["status"], cb);',
        errors: [missingOptions("execFile")],
      },
      {
        code: 'import * as cp from "node:child_process"; cp.spawnSync("git", []);',
        errors: [missingOptions("spawnSync")],
      },
      {
        code: 'import childProcess from "child_process"; childProcess.execFile("git", ["status"], { cwd: "." }, cb);',
        errors: [missingWindowsHide("execFile")],
      },
      {
        code: [
          'import { execFile } from "node:child_process";',
          'import { promisify } from "node:util";',
          "const execFileAsync = promisify(execFile);",
          'await execFileAsync("git", ["status"], { cwd: "." });',
        ].join("\n"),
        errors: [missingWindowsHide("execFile")],
      },
      {
        code: 'const { spawnSync } = require("node:child_process"); spawnSync("git", []);',
        languageOptions: { sourceType: "commonjs" },
        errors: [missingOptions("spawnSync")],
      },
      {
        code: 'const cp = await import("node:child_process"); cp.spawn("git", []);',
        errors: [missingOptions("spawn")],
      },
      {
        code: [
          'import { spawn } from "node:child_process";',
          'spawn("git", [], { windowsHide: true });',
          'spawn("git", [], { stdio: "ignore" });',
        ].join("\n"),
        errors: [missingWindowsHide("spawn")],
      },
    ],
  });
});
