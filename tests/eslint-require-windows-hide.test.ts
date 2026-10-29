import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { requireWindowsHide } from "../scripts/eslint-rules/require-windows-hide.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester();
const tsTester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

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
      // A spread before windowsHide cannot override it.
      { code: 'import { spawn } from "node:child_process"; spawn("git", [], { ...base, windowsHide: true });' },
      { code: 'import { spawn } from "node:child_process"; spawn("git", [], { "windowsHide": true, cwd: "." });' },
      // Direct, defaulted, and destructured aliases are launchers.
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; const run = spawn; run("git", [], { windowsHide: true });',
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; function f({ spawnSyncImpl = spawnSync } = {}) { spawnSyncImpl("git", [], { windowsHide: true }); }',
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; const impl = options.impl ?? spawnSync; impl("git", [], { windowsHide: true });',
      },
      {
        code: 'const { spawn: run } = require("node:child_process"); run("git", [], { windowsHide: true });',
        languageOptions: { sourceType: "commonjs" },
      },
      // Shadowed names are not child_process launchers.
      { code: 'import { exec } from "node:child_process"; function query(exec) { return exec("x"); }' },
      { code: 'import { spawn } from "node:child_process"; function f() { const spawn = make(); return spawn("x"); }' },
      { code: 'import * as cp from "node:child_process"; function f(cp) { return cp.spawn("x"); }' },
      { code: 'import { spawn } from "node:child_process"; const run = (spawn) => spawn("x"); run(fn);' },
      { code: 'import { exec } from "node:child_process"; { const exec = db.exec; exec("select 1"); }' },
      // promisify is resolved through node:util, whatever it is called.
      {
        code: 'import { execFile } from "node:child_process"; import { promisify as toPromise } from "node:util"; const run = toPromise(execFile); run("git", [], { windowsHide: true });',
      },
      {
        code: 'import { execFile } from "node:child_process"; import * as util from "node:util"; const run = util.promisify(execFile); run("git", [], { windowsHide: true });',
      },
      {
        code: 'import { execFile } from "node:child_process"; import util from "util"; const run = util.promisify(execFile); run("git", [], { windowsHide: true });',
      },
      {
        code: 'const { execFile } = require("node:child_process"); const { promisify: p } = require("node:util"); const run = p(execFile); run("git", [], { windowsHide: true });',
        languageOptions: { sourceType: "commonjs" },
      },
      // A promisify that is not Node's is not a wrapper, so its result is not a launcher.
      {
        code: 'import { execFile } from "node:child_process"; const promisify = (fn) => fn; const run = promisify(execFile); run("git");',
      },
      {
        code: 'import { execFile } from "node:child_process"; import { promisify } from "./local.js"; const run = promisify(execFile); run("git");',
      },
      { code: 'import { execFile } from "node:child_process"; const run = helpers.promisify(execFile); run("git");' },
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
        errors: [{ messageId: "windowsHideNotTrue", data: { name: "spawn" } }],
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
      {
        code: 'import { spawn } from "node:child_process"; spawn("git", [], { windowsHide: !debug });',
        errors: [{ messageId: "windowsHideNotTrue", data: { name: "spawn" } }],
      },
      {
        code: 'import { spawn } from "node:child_process"; spawn("git", [], { windowsHide: !true });',
        errors: [{ messageId: "windowsHideNotTrue", data: { name: "spawn" } }],
      },
      {
        code: 'import { spawn } from "node:child_process"; spawn("git", [], { windowsHide: hide });',
        errors: [{ messageId: "windowsHideNotTrue", data: { name: "spawn" } }],
      },
      {
        code: 'import { spawn } from "node:child_process"; spawn("git", [], { windowsHide: true, ...overrides });',
        errors: [{ messageId: "windowsHideOverridable", data: { name: "spawn" } }],
      },
      {
        code: 'import { spawn } from "node:child_process"; spawn("git", [], { windowsHide: true, [key]: 1 });',
        errors: [{ messageId: "windowsHideOverridable", data: { name: "spawn" } }],
      },
      {
        code: 'import { spawn } from "node:child_process"; spawn("git", [], { windowsHide: true, windowsHide: false });',
        errors: [{ messageId: "windowsHideNotTrue", data: { name: "spawn" } }],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; const run = spawn; run("git", []);',
        errors: [missingOptions("spawn")],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; function f({ spawnSyncImpl = spawnSync } = {}) { spawnSyncImpl("git", [], { cwd: "." }); }',
        errors: [missingWindowsHide("spawnSync")],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; function f(run = spawn) { run("git", []); }',
        errors: [missingOptions("spawn")],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; const impl = options.impl ?? spawnSync; impl("git", []);',
        errors: [missingOptions("spawnSync")],
      },
      {
        code: 'const { spawn: run } = require("node:child_process"); run("git", []);',
        languageOptions: { sourceType: "commonjs" },
        errors: [missingOptions("spawn")],
      },
      {
        // Only the shadowing binding is exempt; the import is still checked outside it.
        code: 'import { exec } from "node:child_process"; function f(exec) { exec("x"); } exec("y");',
        errors: [missingOptions("exec")],
      },
      {
        code: 'import { execFile } from "node:child_process"; import { promisify as toPromise } from "node:util"; const run = toPromise(execFile); run("git", ["status"]);',
        errors: [missingOptions("execFile")],
      },
      {
        code: 'import { execFile } from "node:child_process"; import * as util from "node:util"; const run = util.promisify(execFile); run("git", [], { cwd: "." });',
        errors: [missingWindowsHide("execFile")],
      },
      {
        code: 'import { execFile } from "node:child_process"; import util from "util"; const run = util.promisify(execFile); run("git");',
        errors: [missingOptions("execFile")],
      },
      {
        code: 'const { execFile } = require("node:child_process"); const util = require("node:util"); const run = util.promisify(execFile); run("git");',
        languageOptions: { sourceType: "commonjs" },
        errors: [missingOptions("execFile")],
      },
      {
        code: 'const { execFile } = require("node:child_process"); const { promisify: p } = require("node:util"); const run = p(execFile); run("git");',
        languageOptions: { sourceType: "commonjs" },
        errors: [missingOptions("execFile")],
      },
      {
        // A local promisify shadows the import, so only the direct launch is checked.
        code: 'import { execFile } from "node:child_process"; import { promisify } from "node:util"; function f(promisify) { const run = promisify(execFile); run("git"); } execFile("x");',
        errors: [missingOptions("execFile")],
      },
    ],
  });

  // Accessors, conditional aliases, and TypeScript type-only wrappers.
  tester.run("require-windows-hide accessors and conditionals", requireWindowsHide, {
    valid: [
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; const run = sync ? spawnSync : spawn; run("git", [], { windowsHide: true });',
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; spawn("git", [], { get windowsHide() { return false; }, windowsHide: true });',
      },
    ],
    invalid: [
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; spawn("git", [], { windowsHide: true, get windowsHide() { return false; } });',
        errors: [{ messageId: "windowsHideNotTrue", data: { name: "spawn" } }],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; spawn("git", [], { windowsHide: true, set windowsHide(value) {} });',
        errors: [{ messageId: "windowsHideNotTrue", data: { name: "spawn" } }],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; spawn("git", [], { windowsHide: true, windowsHide() { return false; } });',
        errors: [{ messageId: "windowsHideNotTrue", data: { name: "spawn" } }],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; spawn("git", [], { get windowsHide() { return true; } });',
        errors: [{ messageId: "windowsHideNotTrue", data: { name: "spawn" } }],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; const run = sync ? spawnSync : spawn; run("git", []);',
        errors: [missingOptions("spawnSync")],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; const run = sync ? spawnSync : spawn; run("git", [], { cwd: "." });',
        errors: [missingWindowsHide("spawnSync")],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; const run = a ? other : b ? spawn : other; run("git", []);',
        errors: [missingOptions("spawn")],
      },
    ],
  });

  tsTester.run("require-windows-hide TypeScript", requireWindowsHide, {
    valid: [
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; spawn("git", [], { windowsHide: true } satisfies SpawnOptions);',
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; spawn("git", [], { windowsHide: true } as const);',
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; spawn("git", [], { windowsHide: true } as SpawnOptions);',
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; spawn("git", [], <SpawnOptions>{ windowsHide: true });',
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; spawn("git", [], ({ windowsHide: true }) as SpawnOptions);',
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; spawn("git", [], { windowsHide: true as const });',
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; const run = spawn as SpawnFn; run("git", [], { windowsHide: true } as const);',
      },
      { code: 'import { exec } from "node:child_process"; function query(exec: Query) { return exec("x"); }' },
    ],
    invalid: [
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; spawn("git", [], { cwd: "." } satisfies SpawnOptions);',
        errors: [missingWindowsHide("spawn")],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; spawn("git", [], { cwd: "." } as const);',
        errors: [missingWindowsHide("spawn")],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; spawn("git", [], { windowsHide: false } as const);',
        errors: [{ messageId: "windowsHideNotTrue", data: { name: "spawn" } }],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; spawn("git", [], { windowsHide: debug as boolean });',
        errors: [{ messageId: "windowsHideNotTrue", data: { name: "spawn" } }],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; spawn("git", [], { windowsHide: true, ...extra } satisfies SpawnOptions);',
        errors: [{ messageId: "windowsHideOverridable", data: { name: "spawn" } }],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; const run = spawn as SpawnFn; run("git", []);',
        errors: [missingOptions("spawn")],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; const run = (spawn satisfies SpawnFn)!; run("git", []);',
        errors: [missingOptions("spawn")],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; const run = (sync ? spawnSync : spawn) as SpawnFn; run("git", []);',
        errors: [missingOptions("spawnSync")],
      },
      {
        code: 'import * as cp from "node:child_process"; (cp as Cp).spawn("git", []);',
        errors: [missingOptions("spawn")],
      },
      {
        code: 'import { spawn, spawnSync } from "node:child_process"; spawn("git", [], options as SpawnOptions);',
        errors: [missingOptions("spawn")],
      },
    ],
  });
});
