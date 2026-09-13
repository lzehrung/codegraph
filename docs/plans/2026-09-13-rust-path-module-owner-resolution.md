# Rust `#[path]` module owner resolution

Status: Planned. Reproduced defect, no implementation yet.

## Problem

A file reached through `#[path = "..."] mod name;` has no conventional parent directory, so `super::`
resolution has to find the module that declared it. `findPathAttributeParent` in
`src/util/resolution/rust.ts` asks `rustDeclaringFileCandidates` for `.rs` files, walking from the
target's own directory up to the source root, and accepts the first candidate whose `#[path]` value
points at the target. Two properties make that wrong:

- Candidate order is `fs.readdir` order, so the winner depends on file names on disk.
- No candidate is checked for reachability from a crate root, so a file that no module declares can
  own the target.

A crate may legally declare the same `#[path]` target from more than one module, and an abandoned or
generated `.rs` file may sit beside real sources, so both properties are reachable in real checkouts.

## Evidence

Probe, 2026-09-13, against the branch head:

- `src/lib.rs`: `mod real;` plus `pub struct RootThing;`
- `src/real.rs`: `#[path = "shared.rs"] mod shared;` plus `pub struct RealThing;`
- `src/aaa_orphan.rs`: same `#[path]` declaration, declared by nothing
- `src/shared.rs`: `use super::RealThing;`

`collectImportsForFile("src/shared.rs")` resolves `super::RealThing` to `src/aaa_orphan.rs`. The only
reachable owner is `src/real.rs`. The result is a file edge and a go-to-definition target that point
at a module the compiler never builds, decided by the name `aaa_orphan.rs` sorting first.

## Approach

1. Build the reachable module tree once per crate root instead of scanning directories: start from
   `src/lib.rs`, `src/main.rs`, and the `[lib]`/`[[bin]]` paths in `Cargo.toml`, then follow `mod`
   declarations, inline module bodies, and `#[path]` attributes using the existing
   `loadRustPathAttributeScope` walk.
2. Restrict owner candidates to modules in that tree. Keep the directory scan as a fallback only when
   no crate root exists, which is the single-file and non-Cargo case the current tests cover.
3. Decide the ambiguous case explicitly, with a regression either way: when two reachable modules
   declare the same target and disagree about the parent module, prefer no `super` resolution over a
   confidently wrong one. Record the choice in `docs/language-parity.md`.
4. Cache the tree for the duration of a build. Today every attributed lookup re-reads candidate files
   through `loadRustPathAttributeScope`.

## Acceptance

- A regression with the probe layout above: the undeclared file never wins and `super::RealThing`
  resolves to `src/real.rs`.
- A regression where the reachable owner sits in an ancestor directory while a nearer unreachable file
  declares the same target.
- Order independence proven by two differently named unreachable declarers, so the result cannot
  depend on directory-entry order.
- `#[cfg(test)]` suppression, inline-module directories, and root confinement through
  `isExistingAttributedPathInsideProject` keep their current behavior and tests.
- `CORE_ALGORITHM_EPOCH` in `src/indexer/build-cache/options.ts` is bumped, because resolved edges for
  attributed modules change.
- Warm and cold index timings for a Rust corpus do not regress: the module tree replaces per-lookup
  directory reads, so it should reduce filesystem work.
