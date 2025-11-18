;; ================================
;; Python semantic chunk blocks
;; ================================

;; ----- Line comments -----
(comment) @chunk.comment

;; ----- Module-level docstring -----
(module
  (expression_statement
    (string)) @chunk.docstring)

;; ----- Class definitions -----
(class_definition
  name: (identifier) @chunk.name
  body: (block) @chunk.block.class)

;; ----- Function / method definitions -----
(function_definition
  name: (identifier) @chunk.name
  body: (block) @chunk.block.function)

;; ==========================================
;; Inner control-flow blocks (for splitting)
;; ==========================================

(if_statement
  consequence: (block) @chunk.block.inner)

(elif_clause
  consequence: (block) @chunk.block.inner)

(else_clause
  body: (block) @chunk.block.inner)

(for_statement
  body: (block) @chunk.block.inner)

(while_statement
  body: (block) @chunk.block.inner)

(try_statement
  body: (block) @chunk.block.inner)

(except_clause
  (block) @chunk.block.inner)

(finally_clause
  (block) @chunk.block.inner)

(with_statement
  body: (block) @chunk.block.inner)

(match_statement
  body: (block) @chunk.block.inner)

;; ================================
;; Top-level imports & module vars
;; ================================

(module
  [
    (import_statement) @chunk.block.imports
    (import_from_statement) @chunk.block.imports
  ])

(module
  (expression_statement
    (assignment
      left: (identifier) @chunk.name)) @chunk.block.module_var)

