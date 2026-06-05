# Coverage Reports

These reports are compact Markdown summaries generated from local LCOV output.

## Reports

- [JavaScript/TypeScript](./js.md)
- [Rust Native](./native.md)

## Commands

- `npm run test:coverage`: run JavaScript/TypeScript coverage and update `docs/coverage/js.md`.
- `npm run test:coverage:native`: run Rust native coverage and update `docs/coverage/native.md`.
- `npm run test:coverage:all`: run both coverage reports and update this directory.
- `npm run coverage:markdown`: refresh Markdown summaries from existing LCOV files.

Rust native coverage requires `cargo llvm-cov`; install it with `npm run coverage:setup:native`.
