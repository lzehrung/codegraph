---
section: Fixed
---

The shared docstring collector no longer gives the next member or statement the docstring of a comment that ends the previous line of code (`other(): R // note`, `a(); // note`) in TypeScript, TSX, JavaScript (including TypeScript in Vue and Svelte), Java, C#, Kotlin, Rust, Go, Ruby, Zig, Python, C, C++, PHP, SCSS, and Terraform. A doc comment that runs up to its declaration on one line (`class K { /** doc */ m() {} }`) still documents it.
