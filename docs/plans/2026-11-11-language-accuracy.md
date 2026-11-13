# Language accuracy plan

Goal: fewer wrong and missed answers in go-to-definition, references, and detailed-graph edges for
supported languages, measured on real code, not only on hand-written fixtures.

Baseline (main at v3.2.1, 2026-11-11):

- Edge corpus (`tests/edge-corpus/`): 98 open `@known-gap` assertions out of about 900 assertions.
- Call-form matrix (`docs/coverage/call-forms.md`): 0 known gaps.
- Real-code accuracy: not measured. Past checks against compilers were manual (Roslyn on
  Spectre.Console and Terminal.Gui, kotlinc on okio, koin, and kotlinx.serialization, Django and
  Flask).

## Rules for every item

- One pull request per cluster. Each fix changes the `@known-gap` marker into a passing `@ref`,
  `@goto`, or `@def` assertion. Never turn a real defect into `@not-ref`.
- Check the expected answer against the language's compiler or reference implementation where one
  exists.
- Compute per-file facts at index time and aggregate across files at query time. Bump
  `CORE_ALGORITHM_EPOCH` when extracted or resolved index data changes.
- Run `npm run graph:snapshot:check`; every edge added or removed in the graph snapshots must be
  explained in the pull request.
- Before merging, an independent review by a different model family and a full `npm run check`.

## Phase 1: Real-code accuracy benchmark

A checked-in script that indexes pinned open-source repositories, samples sites deterministically,
asks a compiler or language-service oracle for the answer, and reports wrong answers and misses per
language, repository, and syntax form.

- [x] Benchmark harness: pinned corpus manifest (repository URL and commit), deterministic sampling,
      scoring for go-to-definition, references, and call edges, JSON and Markdown reports
      (`npm run accuracy`, `docs/benchmarks/accuracy.md`)
- [x] TypeScript and JavaScript oracle (TypeScript language service)
- [x] C# oracle (Roslyn)
- [x] Baseline results for TypeScript and C# recorded in this plan (below)
- [ ] Python oracle (pyright or jedi)
- [ ] Go oracle (`gopls`)
- [ ] Java and Kotlin: compiler checks only (no scriptable reference oracle)
- [ ] Swift and Ruby: no oracle; rely on the edge corpus
- [ ] Re-rank Phase 2 by measured frequency

### Baseline (seed 1, 400 sites and 80 declarations per repository, main at v3.2.1)

| Repository      | Language   | Correct | Wrong | Missed | External OK | Excluded | Refs precision / recall | Overclaims |
| --------------- | ---------- | ------: | ----: | -----: | ----------: | -------: | ----------------------- | ---------: |
| Zod             | TypeScript |     129 |    11 |     56 |          23 |      181 | 86.1% / 5.2%            |          5 |
| Hono            | TypeScript |     208 |     1 |    123 |          60 |        8 | 74.3% / 40.5%           |          2 |
| Spectre.Console | C#         |     246 |     2 |     78 |          60 |       14 | 89.0% / 23.4%           |          0 |
| Humanizer       | C#         |     263 |     0 |     48 |          83 |        6 | 97.0% / 49.0%           |          0 |

Constructor sites accept the constructed type (including merged or partial declarations) as well as explicit constructors since the benchmark constructor-site correction.

Highest miss rates by syntax form: TypeScript type references (58%) and member accesses (52%); C#
member calls (26%), member accesses (27%), and type references (27%). Wrong answers are rare
(1.0% overall); misses and low reference recall dominate.

### Real-code gaps found by the benchmark

Each fix found by the benchmark adds an edge-corpus case first.

- [ ] C#: a `global using` directive in one file applies to every file of the project
      (Spectre.Console `Properties/Usings.cs`); also project-file `<Using Include="..." />`.
      Reproduced: a type reached only through another file's `global using` is `not_found`.
- [x] TypeScript: Hono `src/types.ts:2354` uses the same-file `MergeTypedResponse` alias from
      `:2653`. Upstream Tree-sitter TypeScript's scanner refused automatic semicolons before
      adjacent generic call signatures (tree-sitter/tree-sitter-typescript#335), swallowing later
      aliases inside an `ERROR`; the pinned grammar fork restores go-to-definition and references.
- [ ] TypeScript: `#private` members. Reproduced: references miss `this.#name(...)` calls and still
      report `complete` coverage.
- [ ] TypeScript: interface members through a typed parameter (`c.value` with
      `c: Context<number>`). Reproduced: `not_found` for go-to-definition and references.
- [ ] TypeScript: a namespace import used as a type qualifier (`import * as schemas` then
      `schemas.X`) resolves to an unrelated module member instead of the import (all 11 Zod wrong
      answers, for example `packages/zod/src/v4/core/api.ts:218`).
- [ ] C#: object-initializer member names resolve to members of the enclosing type (2 Spectre.Console
      wrong answers).

## Phase 2: Known edge-corpus gaps

Paths are relative to `tests/edge-corpus/<language>/`. Order within a language is the suggested
fix order.

### Ruby (19)

- [ ] Index methods generated by `attr_reader`, `attr_writer`, and `attr_accessor`
      (`generated_accessor_not_indexed`: `navigation/api.rb:5`, `:9`, `navigation/consumer.rb:13`,
      `:14`)
- [ ] `self.x = value` calls the writer, not the reader (`self_setter_call_goes_to_reader`:
      `navigation/api.rb:17`; `self_setter_call_reference`: `navigation/api.rb:8`)
- [ ] Typed local reader and writer references (`typed_local_reader_reference`,
      `typed_local_setter_reference`: `navigation/consumer.rb:12`, `:11`)
- [ ] Class method lookup through `def self.name` (`class_method_lookup`:
      `navigation/consumer.rb:19`, `:20`, `:21`)
- [ ] Instance method lookup on a constructed receiver (`instance_method_lookup`:
      `navigation/consumer.rb:22`)
- [ ] Method names ending in `?` and `!` (`predicate_method_call`: `navigation/consumer.rb:6`;
      `predicate_method_reference`: `:15`; `bang_method_reference`: `:16`)
- [ ] Methods from an included module (`included_mixin_method_reference`:
      `navigation/consumer.rb:17`)
- [ ] Reopened classes (`reopened_class_coverage`: `navigation/api.rb:3`;
      `reopened_instance_method_reference`: `navigation/consumer.rb:18`)
- [ ] Assignment to a block-local variable (`block_local_write`: `navigation/consumer.rb:25`)

### PHP (8)

- [ ] Case-insensitive function and method names (`case-insensitive-function-goto`:
      `case-rules/case.php:21`; `case_variant_method_goto`: `namespaces/src/SameNames.php:20`)
- [ ] Namespaced class lookup (`namespace_class_goto`: `namespaces/src/SameNames.php:18`)
- [ ] `parent::` static calls (`parent-static-goto`: `members/model.php:34`;
      `parent-static-reference`: `:33`)
- [ ] Trait members on the using class (`trait-receiver-goto`: `members/model.php:30`;
      `trait-receiver-reference`: `:29`; `trait-promoted-property`: `:8`)

### Swift (12)

- [ ] Enum shorthand `.case` with a known type (`enum-shorthand`: `module/Usage.swift:44`, `:46`,
      `:48`)
- [ ] Overload selection by argument labels (`argument-label`: `module/Usage.swift:20`, `:37`;
      `unlabeled-overload`: `:22`)
- [ ] Nested types and their properties (`nested-type`: `module/Usage.swift:28`, `:30`;
      `nested-property`: `:32`)
- [ ] Protocol default methods (`default-method`: `module/Usage.swift:14`)
- [ ] Private methods within their file (`private_method_goto`: `module/Lookup.swift:10`;
      `private_method_reference`: `:11`)

### C# (14)

- [ ] Receiver properties, including inside interpolated strings (`receiver-property`:
      `declarations/Consumer.cs:13`; `receiver-property-goto`: `:14`;
      `interpolated-receiver-property`: `:30`)
- [ ] Field-typed receivers (`field_receiver_member_goto`: `declarations/FieldTypes.cs:22`)
- [ ] Nested types and members (`nested-type`: `declarations/Consumer.cs:16`; `nested-member`:
      `:17`; `generic_owner_nested_unresolved`: `declarations/GenericOwner.cs:18`)
- [ ] Extension methods (`extension-method`: `declarations/Consumer.cs:20`; `extension-goto`: `:21`)
- [ ] Partial members (`partial-member`: `declarations/Consumer.cs:22`; `partial-member-goto`: `:23`;
      `partial_static_method_reference`: `:19`)
- [ ] Generic alias targets (`generic_alias_target_unresolved`: `declarations/Consumer.cs:12`)
- [ ] `global using static` (`global_static_import_unsupported`: `declarations/GlobalStatic.cs:7`)

### Kotlin (9)

- [ ] Typed receiver members (`typed_receiver_member_unresolved`: `navigation/app/Use.kt:26`)
- [ ] Inner classes: constructor and members (`inner_constructor_receiver_unresolved`:
      `navigation/app/Use.kt:27`; `inner_member_receiver_unresolved`: `:28`, `:29`)
- [ ] Extension properties and aliased extension functions (`extension_property_receiver_unresolved`:
      `navigation/app/Use.kt:21`, `:23`; `extension_function_alias_unresolved`: `:22`)
- [ ] Data-class named arguments (`data_class_named_arguments_unresolved`:
      `navigation/app/Use.kt:33`)
- [ ] Inherited interface members (`inherited_interface_member_goto`:
      `navigation/model/Records.kt:36`)

### TypeScript (9)

- [ ] Generic type parameters as declarations and references
      (`generic_type_parameters_not_indexed`: `syntax/generics.ts:3`;
      `generic_type_parameter_reference_missing`: `:5`, `:6`)
- [ ] Typed field chains (`typed_field_chain_goto`: `tsx/field-chain.tsx:9`;
      `typed_field_chain_reference`: `:8`)
- [ ] Object shorthand properties as references (`object_shorthand_reference`:
      `modules/shorthand.ts:3`)
- [ ] `declare module` ambient modules (`ambient_module_import_not_resolved`:
      `syntax/consumer.ts:1`; `ambient_module_call_not_resolved`: `:3`)
- [ ] Re-export references in a file with a parse error (`parse_error_reexport_reference`:
      `modules/error-consumer.ts:3`)

### C and C++ (8)

- [ ] C struct and union member navigation (`struct_member_navigation`:
      `translation-units/consumer.c:21`, `:22`; `union_member_navigation`: `:20`)
- [ ] C++ `using` declarations and type aliases (`using_declaration_reference`:
      `navigation/use.cpp:4`; `using_type_member_goto`: `:24`; `using_type_static_member_goto`: `:23`)
- [ ] C++ qualified static members (`qualified_static_goto`: `navigation/use.cpp:28`;
      `qualified_static_reference`: `navigation/api.cpp:15`)

### Zig (5)

- [ ] Nested container methods, imported and local (`nested_imported_method_goto`:
      `containers/consumer.zig:8`; `nested_imported_method_reference`: `:7`;
      `nested_method_reference`: `containers/api.zig:30`; `nested_private_method_reference`: `:34`)
- [ ] Struct field references (`struct_field_reference`: `containers/api.zig:6`)

### Rust (5)

- [ ] Re-exported alias calls (`reexport_alias_call_not_resolved`: `crate/src/consumer.rs:10`)
- [ ] Cargo dependencies with a custom `lib` path (`cargo_dependency_lib_path`:
      `custom-lib-path/src/lib.rs:2`) and invalid path dependencies (`invalid_path_dependency`:
      `invalid-path-dependency/src/lib.rs:4`)
- [ ] Field navigation in a file with a parse error (`parse_error_field_goto`:
      `crate/src/field_error.rs:5`; `parse_error_field_reference`: `:4`)

### Java (3)

- [ ] Inner-class constructors (`inner-constructor-goto`: `navigation/consumer/Client.java:17`;
      `inner-constructor-reference`: `:16`)
- [ ] Inner-class owner as a return type (`inner-owner-return-type-reference`:
      `navigation/api/Service.java:19`)

### Go (2)

- [ ] Promoted fields of embedded structs (`embedded_promoted_field`:
      `resolution/widget/methods.go:34`; `embedded_promoted_field_goto`: `:35`)

### Svelte (2)

- [ ] `$store` auto-subscriptions (`svelte-store-dollar-goto`: `stores/Counter.svelte:8`;
      `svelte-store-dollar-reference`: `:7`)

### Python (1)

- [ ] Annotation references inside `if TYPE_CHECKING:` (`type_checking_annotation_reference_not_recorded`:
      `imports/pkg/sub/consumer.py:9`)

### SCSS (1)

- [ ] Hyphen and underscore equivalence in Sass names (`sass_hyphen_underscore_reference`:
      `modules/edge-cases.scss:35`)

## Phase 3: Dependency signatures

Read-only signatures from dependencies prove or disprove answers inside the project; they never
become navigation targets. Design draft: `dependency-signatures-design.md` (not yet in the
repository).

- [ ] Decision: explicit classpath and SDK configuration, or automatic discovery
- [ ] Decision: binary metadata readers (class files, Kotlin metadata, .NET assemblies) in the Rust
      addon, beyond the Tree-sitter-only rule in `AGENTS.md`
- [ ] Decision: privacy rules for the local signature cache
- [ ] JVM: JDK and project JARs
- [ ] .NET reference assemblies
- [ ] TypeScript `.d.ts` files, Python stubs, Go and Rust sources, Swift interfaces

## Phase 4: Declared return types (needs approval)

Use a function's declared return type for `val x = foo()` and similar receivers. This is at the
edge of the "no expression type inference" rule in `AGENTS.md`.

- [ ] Decision: in scope or not
- [ ] If approved: declared return types for receivers in Kotlin, Java, C#, Swift, and TypeScript
