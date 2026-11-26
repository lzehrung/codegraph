---
section: Fixed
---

The detailed graph records a `calls` edge for a qualified Ruby call of a module method that the module hands to itself in the same file (`module_function`, `extend self`), such as `Tools.calculate` in a parameter default, matching `goToDefinition`. It records none where the module has its own method of that name, makes it private with `private_class_method`, or is opened in another file.
