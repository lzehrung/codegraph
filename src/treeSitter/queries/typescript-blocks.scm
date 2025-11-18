;; ==================================
;; TypeScript semantic chunk blocks
;; ==================================

;; ----- Comments -----
(comment) @chunk.comment

;; ----- Classes -----
(class_declaration
  name: (type_identifier) @chunk.name) @chunk.block.class

;; ----- Standalone function declarations -----
(function_declaration
  name: (identifier) @chunk.name) @chunk.block.function

;; ----- Methods inside classes and objects -----
(method_definition
  name: (_) @chunk.name
  body: (statement_block) @chunk.block.method)

;; ----- Functions / arrows assigned to variables -----
(lexical_declaration
  (variable_declarator
    name: (identifier) @chunk.name
    value: [
      (function_expression
        body: (statement_block) @chunk.block.function)
      (arrow_function
        body: (statement_block) @chunk.block.function)
    ]))

(variable_declaration
  (variable_declarator
    name: (identifier) @chunk.name
    value: [
      (function_expression
        body: (statement_block) @chunk.block.function)
      (arrow_function
        body: (statement_block) @chunk.block.function)
    ]))

;; ----- Functions / arrows assigned via assignment -----
(assignment_expression
  left: (_) @chunk.name
  right: [
    (function_expression
      body: (statement_block) @chunk.block.function)
    (arrow_function
      body: (statement_block) @chunk.block.function)
  ])

;; ----- Remaining arrow functions with block bodies -----
(arrow_function
  body: (statement_block) @chunk.block.function)

;; ----- Remaining function expressions with block bodies -----
(function_expression
  body: (statement_block) @chunk.block.function)

;; ==========================================
;; Inner control-flow blocks (for splitting)
;; ==========================================

(if_statement
  consequence: (statement_block) @chunk.block.inner)

(else_clause
  (statement_block) @chunk.block.inner)

(switch_statement
  body: (switch_body) @chunk.block.inner)

;; Capture individual cases so we can split large switches intelligently
(switch_case) @chunk.block.inner
(switch_default) @chunk.block.inner

(for_statement
  body: (statement_block) @chunk.block.inner)

;; for_in_statement covers both for..in and for..of
(for_in_statement
  body: (statement_block) @chunk.block.inner)

(while_statement
  body: (statement_block) @chunk.block.inner)

(do_statement
  body: (statement_block) @chunk.block.inner)

(try_statement
  body: (statement_block) @chunk.block.inner)

(catch_clause
  body: (statement_block) @chunk.block.inner)

(finally_clause
  body: (statement_block) @chunk.block.inner)

;; ==========================================
;; Data Structures & JSX
;; ==========================================

;; Capture large objects (configs, props) as coherent blocks
(object) @chunk.block.data

;; JSX omitted for standard TypeScript grammar (use tsx-blocks.scm for TSX)

;; ----- Interfaces -----
(interface_declaration
  name: (type_identifier) @chunk.name) @chunk.block.interface

;; ----- Enums -----
(enum_declaration
  name: [
    (identifier)
    (type_identifier)
  ] @chunk.name) @chunk.block.enum

;; ----- Type aliases -----
(type_alias_declaration
  name: (type_identifier) @chunk.name) @chunk.block.type_alias

;; ----- Namespaces / modules -----
(internal_module
  name: (identifier) @chunk.name
  body: (statement_block) @chunk.block.namespace)

(module
  name: (identifier) @chunk.name
  body: (statement_block) @chunk.block.namespace)

;; ================================
;; Top-level imports & module vars
;; ================================

(program
  (import_statement) @chunk.block.imports)

(program
  [
    (lexical_declaration
      (variable_declarator
        name: (identifier) @chunk.name) @chunk.block.module_var)
    (variable_declaration
      (variable_declarator
        name: (identifier) @chunk.name) @chunk.block.module_var)
  ])
