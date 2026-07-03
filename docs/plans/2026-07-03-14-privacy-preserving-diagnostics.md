# Privacy-preserving diagnostics

## Goal

Collect useful local diagnostics for maintainers and users without sending data anywhere by default.

Command:

```bash
codegraph diagnostics collect --out codegraph-diagnostics.json
codegraph diagnostics doctor --json
```

## Design

Add a local diagnostics bundle that users can inspect before sharing. This is not telemetry and should not perform network requests.

Collected data must be coarse and content-free:

- Codegraph version
- Node version
- OS/arch
- native runtime availability
- supported language ids
- command/report schema versions
- recent doctor findings
- config shape, not config values that may contain paths beyond project-relative globs
- cache mode and whether cache is readable
- counts by language, not file names
- error categories, not source snippets

Do not collect:

- source code
- file paths by default
- symbol names
- search queries
- repository URLs
- environment variables
- usernames/hostnames

## Output

```ts
type DiagnosticsBundle = {
  schemaVersion: 1;
  createdAt: string;
  package: { name: string; version: string };
  runtime: { node: string; os: string; arch: string };
  native: { available: boolean; supportedLanguageIds: string[] };
  project?: {
    initialized?: boolean;
    fileCountByLanguage?: Record<string, number>;
    configPresent: boolean;
  };
  findings: Array<{ severity: "info" | "warn" | "error"; code: string; message: string }>;
};
```

## Future network opt-in

If maintainers later want telemetry, make it a separate explicit proposal. Do not add background uploads in this PR.

## Files likely touched

- `src/cli/help.ts`
- `src/cli/options.ts`
- `src/cli.ts`
- new `src/cli/diagnostics.ts`
- `src/cli/doctor.ts` shared helpers
- `docs/cli.md`
- `docs/installation.md` troubleshooting section
- tests under new `tests/diagnostics.test.ts`

## Tests

- diagnostics bundle has stable schema.
- no absolute file paths appear by default.
- no source snippets or symbol names appear.
- native availability is reported.
- output file write is root-safe or explicit path-safe.
- JSON validates under offline conditions.

## Acceptance

- Users can generate a shareable diagnostics file for bug reports.
- The command is local-only and privacy-preserving by construction.
- Maintainers get enough environment/runtime context to debug install and parser issues.

## Review pass

Checked scope: this plan intentionally avoids telemetry. It delivers the useful debugging part first while preserving a simple privacy story.
