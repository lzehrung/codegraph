# Accuracy audit checklist (main ef8ba401, 2026-09-25)

Source: the pre-release audit of `main` at `ef8ba401`. Every item was reproduced on `main` and on the
published 2.3.31 with the same result, so none is a regression. The semantic accuracy bar in
`AGENTS.md` decides the fix: a result must be correct, or it must say `not_found` or `partial`.

Status: `[ ]` open, `[~]` fix on a worker branch, `[x]` merged into `fix/audit-accuracy-gaps` with a
regression test.

## Cross-cutting fixes (do first)

- [ ] **F1 Consumers agree.** `goToDefinition`, `findReferences`, and `buildSymbolGraphDetailed` give
      the same answer for the same use site. Add a cross-consumer agreement test that runs every
      fixture below through all three consumers.
- [ ] **F2 Same-package and same-namespace peers.** Java, Kotlin, Swift, and PHP resolve a peer
      declaration without an import, the way C# already does (W5, W12).
- [ ] **F3 No `complete` with an unresolved use.** A same-name use in a scanned candidate file that
      resolves to nothing makes coverage `partial`; it is not dropped silently.

## Wrong answers (break the accuracy bar)

| Done | ID  | Language          | Case                                                                                                                             | Observed                                                                                                                                                                                                                                         |
| ---- | --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [ ]  | W1  | TypeScript        | Overloaded function or method called from another file or through `this`                                                         | `not_found`; earlier overload signatures missing from symbols and graph                                                                                                                                                                          |
| [ ]  | W2  | TS/JS             | `export default class X` or `module.exports = X`, then `X.create()` / `new X().m()`                                              | `not_found`; references `complete` without the use                                                                                                                                                                                               |
| [ ]  | W3  | JavaScript        | `const util = require("./util"); util.helper()`                                                                                  | `not_found`; references `complete` without the use                                                                                                                                                                                               |
| [ ]  | W4  | TS/JS             | `const mod = await import("./lazy"); mod.thing()`                                                                                | references `complete` without the use                                                                                                                                                                                                            |
| [ ]  | W5  | Java/Kotlin/Swift | Same-package call without an import (`new Foo().hello()`)                                                                        | `not_found`; references `complete`; the graph has the `calls` edge                                                                                                                                                                               |
| [ ]  | W6  | Swift             | `init(name: String) { self.name = name }`                                                                                        | `self.name` unresolved; references `complete`                                                                                                                                                                                                    |
| [ ]  | W7  | Rust              | `super::Circle` in a type position                                                                                               | wrong target: the use site as a high-confidence variable                                                                                                                                                                                         |
| [ ]  | W8  | Rust              | Workspace path dependency `use crate_a::greet`                                                                                   | `not_found`; references `complete`                                                                                                                                                                                                               |
| [ ]  | W9  | C                 | Header prototype and `.c` definition                                                                                             | each side misses the other or the callers; both `complete`                                                                                                                                                                                       |
| [ ]  | W10 | C++               | `using namespace tools; add(1, 2)`                                                                                               | `not_found`; references `complete`                                                                                                                                                                                                               |
| [ ]  | W11 | Go                | Unexported name used from another package                                                                                        | resolves and counts as a reference; Go rejects this code                                                                                                                                                                                         |
| [ ]  | W12 | PHP               | Same-namespace `extends Base`, trait `use`, `parent::` without a `use` import                                                    | `not_found`; no `extends` edge; references do find the site                                                                                                                                                                                      |
| [ ]  | W13 | Ruby              | `w = Widget.new; w.render` with `Widget` in another file                                                                         | `not_found`; references `complete`                                                                                                                                                                                                               |
| [ ]  | W14 | Python            | Class named like its module (`widget.py`/`Widget`) through a package re-export + alias                                           | references `complete`, every consumer missing                                                                                                                                                                                                    |
| [ ]  | W15 | Python            | `import pkg.mod` then `pkg.mod.foo()`                                                                                            | `not_found`; references `complete`                                                                                                                                                                                                               |
| [ ]  | W16 | Zig               | `self.area()` inside the struct                                                                                                  | `goToDefinition` ok; references only the declaration, `complete`                                                                                                                                                                                 |
| [ ]  | W17 | Star-import langs | Two files export the same name through star imports (Ruby `require_relative`, Python `import *`, Rust `use x::*`, JVM wildcards) | `goToDefinition` falls back to the first match in file order with medium confidence (`src/indexer/navigation-local.ts` `resolveNamedDefinition`); after G4 the Ruby graph shares this resolver, so the fix also removes the wrong `extends` edge |
| [ ]  | W18 | Ruby              | `module Outer; class Base; end; end` exports a bare top-level `Base` (`src/languages/definitions/ruby.ts` exports query)         | `class Worker < Base` resolves to `Outer::Base` instead of the real top-level `Base`; the graph `extends` edge follows it                                                                                                                        |

## Graph, cache, and API gaps

| Done | ID  | Area              | Case                                                                                                   |
| ---- | --- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| [ ]  | G1  | Disk cache        | A new file that makes an existing unresolved import resolvable is ignored by a warm build              |
| [ ]  | G2  | Package manifests | Nearest-manifest lookup reads above `--root` when no `.git` exists                                     |
| [ ]  | G3  | Go graph          | No `calls` edge for a cross-package call (`u.Square()`) that navigation resolves                       |
| [ ]  | G4  | Ruby graph        | Cross-file `class A < B`, `include`, `extend` give no edge; `goToDefinition` resolves `B`              |
| [ ]  | G5  | TS graph          | `Box.create()` static call has a `uses` edge but no `calls` edge                                       |
| [ ]  | G6  | Agent API         | `freshness: { policy: "manual" }` makes `checkFreshness()` report `fresh` without a check (since #353) |

## Honest misses on common code

| Done | ID  | Language             | Case                                                                                                    |
| ---- | --- | -------------------- | ------------------------------------------------------------------------------------------------------- |
| [ ]  | H1  | TypeScript           | Enum or class member through a same-named parameter type context (`Status.Active`), `partial`           |
| [ ]  | H2  | Kotlin               | Companion-object factory `Widget.create()`                                                              |
| [ ]  | H3  | Kotlin               | Extension function call `w.describe()`                                                                  |
| [ ]  | H4  | C#                   | Member call on a constructed nested or generic local (`new Outer.Inner()`, `new Box<int>()`)            |
| [ ]  | H5  | C#                   | `using PT = N.Point;` alias to a type                                                                   |
| [ ]  | H6  | Java/Kotlin/C#/Swift | Member call on an explicitly typed parameter (`void use(Greeter g) { g.hello(); }`)                     |
| [ ]  | H7  | C++                  | Member call on an explicitly typed local (`Box b; b.run();`)                                            |
| [ ]  | H8  | PHP                  | `new self()` / `new static()`: navigation and `instantiates` edge                                       |
| [ ]  | H9  | PHP                  | PHP 8 constructor-promoted properties through `$this->x`                                                |
| [ ]  | H10 | Ruby                 | Block parameters (`each do \|item\|`)                                                                   |
| [ ]  | H11 | Python               | Source-side name in `from a import helper as h`                                                         |
| [ ]  | H12 | Python/Ruby          | `super().m()` and Ruby `super` with a proven base class                                                 |
| [ ]  | H13 | Rust/Zig             | Rust `use x::*`, struct-literal receivers, a `bin` importing its own lib; Zig qualified struct literals |

## Integration

- [ ] Bump cache epochs and snapshot versions once for the combined behavior change.
- [ ] Update `docs/language-parity.md`, `CHANGELOG.md` (`[Unreleased]`), and fixture reports.
- [ ] `npm run check`, fresh independent review, PR, Copilot review.
