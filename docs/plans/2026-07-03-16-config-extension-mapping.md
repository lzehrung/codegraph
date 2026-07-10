# Configurable extension mapping

## Goal

Allow projects to map nonstandard file extensions to already-supported languages through `codegraph.config.json`.

Example:

```json
{
  "languages": {
    "extensions": {
      ".tpl": "php",
      ".inc.php": "php",
      ".build.ts": "ts"
    }
  }
}
```

## Design

Extend the existing config schema. Keep mappings limited to language ids already known to Codegraph.

Config type:

```ts
type CodegraphConfig = {
  discovery?: ProjectFileDiscoveryOptions;
  languages?: {
    extensions?: Record<string, string>;
  };
};
```

Rules:

- Extension keys must be literal suffixes starting with `.` and containing only letters, digits, `.`, `_`, `+`, or `-`.
- Values must be supported language ids.
- Longer extension keys win first, so `.inc.php` beats `.php`.
- Built-in extensions remain unless explicitly remapped; `.vue` and `.svelte` remain single-file components and cannot be remapped.
- Invalid mappings fail config validation with actionable errors.

## Integration

Thread extension mapping into language detection, not individual commands.

Likely approach:

- Add a `LanguageResolver` or extend existing language lookup helpers.
- Load config at the project boundary.
- Merge built-in extensions with config mapping.
- Include normalized mapping in cache keys/build options hash.
- Ensure CLI include/ignore glob semantics remain unchanged.

## Non-goals

- Do not load arbitrary grammars from config.
- Do not allow shell commands or parser package names in config.
- Do not claim new language support through extension mapping alone.

## Files likely touched

- `src/config.ts`
- `src/languages.ts`
- language detection utilities under `src/languages/`
- index/build cache key code
- CLI context/config loading
- `docs/cli.md`
- `docs/installation.md` or `docs/language-parity.md`
- `README.md` if public config surface changes
- `codegraph-skill/codegraph/SKILL.md` if config guidance changes
- tests under new `tests/config-extension-mapping.test.ts`

## Tests

- `.tpl` mapped to `php` is indexed as PHP.
- longest extension wins.
- invalid extension key fails validation.
- unknown language id fails validation.
- cache invalidates when mapping changes.
- built-in extension still works when unrelated mapping exists.
- remapping a built-in extension behaves deterministically and is documented.

## Acceptance

- Users can index supported-language files with project-specific extensions.
- Mapping behavior is deterministic across CLI, library sessions, MCP, and artifacts.
- Config docs distinguish durable project mappings from one-off include/ignore globs.

## Review pass

Checked scope: this plan adds flexibility without dynamic parser loading. It keeps language support bounded to known ids and makes mapping part of cache identity.
