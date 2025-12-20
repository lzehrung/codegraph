---
name: Plan
overview: ""
todos: []
---

No code changes will be made until you approve this plan.

# Plan

1. **Identify JSON import patterns**

- Locate existing JS/TS import parsing (queries & collectors) to understand where specifiers become edges and symbols.
- Confirm current behavior for `import data from './file.json'` and `import data from './foo.json' assert { type: 'json' }`.

2. **Extend language support**

- Update JS/TS language configuration to recognize `.json` specifiers as modules with default exports.
- Decide how to represent JSON modules internally (e.g., pseudo-symbol `default` with object literal payload).

3. **Resolve JSON specifiers**

- Enhance resolver to map `.json` paths to actual files, respecting TS path aliases and package resolution.
- Ensure JSON modules participate in caching/invalidation logic.

4. **Graph/index integration**

- When collectors see `.json` import, emit dependency edge to the JSON file and create a stub symbol in the index.
- Mark JSON files as leaf modules with a synthetic default export (static object semantics).

5. **Testing**

- Add fixtures (JS importing JSON) covering default imports, named imports (error), and import assertions.
- Write tests ensuring graph edges, symbol indexing, and go-to-definition behave correctly for JSON modules.