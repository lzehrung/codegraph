---
section: Fixed
---

C# global namespace, alias, and static usings now apply across their nearest project in navigation, references, and detailed graphs, including literal project and Directory.Build.props `Using` items with XML preambles or child metadata. Using-only edits retain source modules, with shared compilation lookup indexes and stat-validated metadata snapshots. C# and Java record-body members stay out of namespace/package exports.
