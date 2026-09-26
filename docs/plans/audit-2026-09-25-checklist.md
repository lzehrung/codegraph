# Accuracy audit checklist (main ef8ba401, 2026-09-25)

Source: the pre-release audit of `main` at `ef8ba401`. Every item was reproduced on `main`. A second
run against the published 2.3.31 (the first comparison did not load 2.3.31) shows three items that
are **regressions in unreleased `main`**, marked `(regression)`: W1, W6, and W13. The other items
behave the same in 2.3.31, or better on `main`. The semantic accuracy bar in `AGENTS.md` decides the
fix: a result must be correct, or it must say `not_found` or `partial`.

Status: `[ ]` open, `[~]` fix on a worker branch, `[x]` merged into `fix/audit-accuracy-gaps` with a
regression test.

## Cross-cutting fixes (do first)

- [x] **F1 Consumers agree.** `goToDefinition`, `findReferences`, and `buildSymbolGraphDetailed` give
      the same answer for the same use site. Add a cross-consumer agreement test that runs every
      fixture below through all three consumers.
- [x] **F2 Same-package and same-namespace peers.** Java, Kotlin, Swift, and PHP resolve a peer
      declaration without an import, the way C# already does (W5, W12).
- [x] **F3 No `complete` with an unresolved use.** A same-name use in a scanned candidate file that
      resolves to nothing makes coverage `partial`; it is not dropped silently.

## Wrong answers (break the accuracy bar)

| Done | ID  | Language          | Case                                                                                                                             | Observed                                                                                                                                                                                                                                         |
| ---- | --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [x]  | W1  | TypeScript        | (regression) Overloaded function or method called from another file or through `this`                                            | `not_found`; earlier overload signatures missing from symbols and graph                                                                                                                                                                          |
| [x]  | W2  | TS/JS             | `export default class X` or `module.exports = X`, then `X.create()` / `new X().m()`                                              | `not_found`; references `complete` without the use                                                                                                                                                                                               |
| [x]  | W3  | JavaScript        | `const util = require("./util"); util.helper()`                                                                                  | `not_found`; references `complete` without the use                                                                                                                                                                                               |
| [x]  | W4  | TS/JS             | `const mod = await import("./lazy"); mod.thing()`                                                                                | references `complete` without the use                                                                                                                                                                                                            |
| [x]  | W5  | Java/Kotlin/Swift | Same-package call without an import (`new Foo().hello()`)                                                                        | `not_found`; references `complete`; the graph has the `calls` edge                                                                                                                                                                               |
| [x]  | W6  | Swift             | (regression) `init(name: String) { self.name = name }`                                                                           | `self.name` unresolved; references `complete`                                                                                                                                                                                                    |
| [x]  | W7  | Rust              | `super::Circle` in a type position                                                                                               | wrong target: the use site as a high-confidence variable                                                                                                                                                                                         |
| [x]  | W8  | Rust              | Workspace path dependency `use crate_a::greet`                                                                                   | `not_found`; references `complete`                                                                                                                                                                                                               |
| [x]  | W9  | C                 | Header prototype and `.c` definition                                                                                             | each side misses the other or the callers; both `complete`                                                                                                                                                                                       |
| [x]  | W10 | C++               | `using namespace tools; add(1, 2)`                                                                                               | `not_found`; references `complete`                                                                                                                                                                                                               |
| [x]  | W11 | Go                | Unexported name used from another package                                                                                        | resolves and counts as a reference; Go rejects this code                                                                                                                                                                                         |
| [x]  | W12 | PHP               | Same-namespace `extends Base`, trait `use`, `parent::` without a `use` import                                                    | `not_found`; no `extends` edge; references do find the site                                                                                                                                                                                      |
| [x]  | W13 | Ruby              | (regression) `w = Widget.new; w.render` with `Widget` in another file                                                            | `not_found`; references `complete`                                                                                                                                                                                                               |
| [x]  | W14 | Python            | Class named like its module (`widget.py`/`Widget`) through a package re-export + alias                                           | references `complete`, every consumer missing                                                                                                                                                                                                    |
| [x]  | W15 | Python            | `import pkg.mod` then `pkg.mod.foo()`                                                                                            | `not_found`; references `complete`                                                                                                                                                                                                               |
| [x]  | W16 | Zig               | `self.area()` inside the struct                                                                                                  | `goToDefinition` ok; references only the declaration, `complete`                                                                                                                                                                                 |
| [x]  | W17 | Star-import langs | Two files export the same name through star imports (Ruby `require_relative`, Python `import *`, Rust `use x::*`, JVM wildcards) | `goToDefinition` falls back to the first match in file order with medium confidence (`src/indexer/navigation-local.ts` `resolveNamedDefinition`); after G4 the Ruby graph shares this resolver, so the fix also removes the wrong `extends` edge |
| [x]  | W18 | Ruby              | `module Outer; class Base; end; end` exports a bare top-level `Base` (`src/languages/definitions/ruby.ts` exports query)         | `class Worker < Base` resolves to `Outer::Base` instead of the real top-level `Base`; the graph `extends` edge follows it                                                                                                                        |
| [x]  | W19 | All languages     | A same-file use of a name declared later in the file (forward reference)                                                         | references omit the use and still report `complete` (single-pass scope-occurrence walk in `src/indexer/scope.ts`)                                                                                                                                |
| [x]  | W20 | Kotlin            | `Box.instanceHelper()` calls an instance method through the type name (invalid Kotlin)                                           | `goToDefinition` resolves it; the detailed graph already refuses the edge                                                                                                                                                                        |

## Graph, cache, and API gaps

| Done | ID  | Area              | Case                                                                                                   |
| ---- | --- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| [x]  | G1  | Disk cache        | A new file that makes an existing unresolved import resolvable is ignored by a warm build              |
| [x]  | G2  | Package manifests | Nearest-manifest lookup reads above `--root` when no `.git` exists                                     |
| [x]  | G3  | Go graph          | No `calls` edge for a cross-package call (`u.Square()`) that navigation resolves                       |
| [x]  | G4  | Ruby graph        | Cross-file `class A < B`, `include`, `extend` give no edge; `goToDefinition` resolves `B`              |
| [x]  | G5  | TS graph          | `Box.create()` static call has a `uses` edge but no `calls` edge                                       |
| [x]  | G6  | Agent API         | `freshness: { policy: "manual" }` makes `checkFreshness()` report `fresh` without a check (since #353) |
| [x]  | G7  | Rust graph        | `impl` block methods get no `member_of` edge, so Rust method calls (`c.area()`) get no `calls` edge    |

## Honest misses on common code

| Done | ID  | Language             | Case                                                                                                                                                  |
| ---- | --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [x]  | H1  | TypeScript           | Enum or class member through a same-named parameter type context (`Status.Active`), `partial`                                                         |
| [x]  | H2  | Kotlin               | Companion-object factory `Widget.create()`                                                                                                            |
| [x]  | H3  | Kotlin               | Extension function call `w.describe()`                                                                                                                |
| [x]  | H4  | C#                   | Member call on a constructed nested or generic local (`new Outer.Inner()`, `new Box<int>()`)                                                          |
| [x]  | H5  | C#                   | `using PT = N.Point;` alias to a type                                                                                                                 |
| [x]  | H6  | Java/Kotlin/C#/Swift | Member call on an explicitly typed parameter (`void use(Greeter g) { g.hello(); }`)                                                                   |
| [x]  | H7  | C++                  | Member call on an explicitly typed local (`Box b; b.run();`)                                                                                          |
| [x]  | H8  | PHP                  | `new self()` / `new static()`: navigation and `instantiates` edge                                                                                     |
| [x]  | H9  | PHP                  | PHP 8 constructor-promoted properties through `$this->x`                                                                                              |
| [x]  | H10 | Ruby                 | Block parameters (`each do \|item\|`)                                                                                                                 |
| [x]  | H11 | Python               | Source-side name in `from a import helper as h`                                                                                                       |
| [x]  | H12 | Python/Ruby          | `super().m()` and Ruby `super` with a proven base class                                                                                               |
| [x]  | H13 | Rust/Zig             | Rust `use x::*`, struct-literal receivers, a `bin` importing its own lib; Zig qualified struct literals                                               |
| [x]  | H14 | Kotlin               | A class whose method body reads a constructor property (`class G(val name: String) { fun d() = name }`): `g.d()` from another function is `not_found` |
| [x]  | H15 | Rust                 | Workspace-inherited dependency (`crate_a = { workspace = true }`) does not resolve                                                                    |

## Integration

- [x] Bump cache epochs and snapshot versions once for the combined behavior change.
- [ ] Update `docs/language-parity.md`, `CHANGELOG.md` (`[Unreleased]`), and fixture reports.
- [ ] `npm run check`, fresh independent review, PR, Copilot review.
