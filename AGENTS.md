# AGENT DIRECTIVES

## General

- Never use `any` or `as unknown as`
- Never use `=== true`, `=== false`, etc. in boolean conditions; keep them as terse and simple as possible like `!condition`. Extract conditions to variables when the variable name adds clarity/insight into the reason for the condition.
- Always consider the impact of a change on tests or when more test cases are needed. Never make tests pass for the sake of passing; always exercise real behavior.
- Keep documentation updated and accurate while being minimal and concise.