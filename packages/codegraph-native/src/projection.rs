use std::collections::HashMap;

/// Default AST node budget for projected syntax trees.
/// Far above ordinary source files (typically thousands of nodes) while capping
/// projection memory for generated/minified inputs.
pub(crate) const DEFAULT_MAX_PROJECTED_NODES: usize = 250_000;

/// Default maximum nesting depth for projected syntax trees.
/// Well above realistic hand-written nesting; catches pathological generated trees
/// without affecting ordinary files. Iterative traversal removes stack risk; the
/// depth cap still fails fast before allocating a huge frontier.
pub(crate) const DEFAULT_MAX_PROJECTED_DEPTH: u32 = 512;

#[derive(Debug, Clone, Copy)]
pub(crate) struct ProjectionLimits {
    pub max_nodes: usize,
    pub max_depth: u32,
}

impl Default for ProjectionLimits {
    fn default() -> Self {
        Self {
            max_nodes: DEFAULT_MAX_PROJECTED_NODES,
            max_depth: DEFAULT_MAX_PROJECTED_DEPTH,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProjectionError {
    NodeLimit { limit: usize },
    DepthLimit { limit: u32 },
}

impl ProjectionError {
    pub(crate) fn message(&self) -> String {
        match self {
            Self::NodeLimit { limit } => {
                format!("syntax tree projection exceeded max node limit ({limit})")
            }
            Self::DepthLimit { limit } => {
                format!("syntax tree projection exceeded max depth limit ({limit})")
            }
        }
    }
}

/// Deduplicates the small set of distinct strings a grammar produces (node kinds,
/// child field names) so each one is allocated and marshalled once per file rather
/// than once per node.
struct Interner {
    values: Vec<String>,
    index: HashMap<String, u32>,
}

impl Interner {
    fn new() -> Self {
        Self {
            values: Vec::new(),
            index: HashMap::new(),
        }
    }

    fn intern(&mut self, value: &str) -> u32 {
        if let Some(id) = self.index.get(value) {
            return *id;
        }
        let id = self.values.len() as u32;
        self.values.push(value.to_string());
        self.index.insert(value.to_string(), id);
        id
    }
}

/// Column-oriented projection result. Every vector except the string tables and the
/// child lists is indexed by node id.
#[derive(Debug)]
pub(crate) struct ProjectedColumns {
    pub root_id: u32,
    pub kinds: Vec<String>,
    pub field_names: Vec<String>,
    pub kind_ids: Vec<u32>,
    pub parent_ids: Vec<i32>,
    pub named: Vec<u8>,
    pub start_row: Vec<u32>,
    pub start_column: Vec<u32>,
    pub start_index: Vec<u32>,
    pub end_row: Vec<u32>,
    pub end_column: Vec<u32>,
    pub end_index: Vec<u32>,
    pub child_offsets: Vec<u32>,
    pub child_ids: Vec<u32>,
    pub child_field_name_ids: Vec<u32>,
    pub named_child_offsets: Vec<u32>,
    pub named_child_ids: Vec<u32>,
}

impl ProjectedColumns {
    pub(crate) fn node_count(&self) -> u32 {
        self.kind_ids.len() as u32
    }
}

/// Per-node attribute columns plus the bookkeeping needed to lay out child lists.
struct Builder {
    kinds: Interner,
    field_names: Interner,
    kind_ids: Vec<u32>,
    parent_ids: Vec<i32>,
    named: Vec<u8>,
    start_row: Vec<u32>,
    start_column: Vec<u32>,
    start_index: Vec<u32>,
    end_row: Vec<u32>,
    end_column: Vec<u32>,
    end_index: Vec<u32>,
    /// Number of children seen so far, which doubles as the next child's slot.
    child_count: Vec<u32>,
    named_child_count: Vec<u32>,
    /// This node's position within its parent's child list.
    child_slot: Vec<u32>,
    named_child_slot: Vec<u32>,
    /// Field name this node carries as a child of its parent.
    field_name_id: Vec<u32>,
}

impl Builder {
    fn new() -> Self {
        let mut field_names = Interner::new();
        // Reserve id 0 for the empty field name, which most children carry.
        field_names.intern("");
        Self {
            kinds: Interner::new(),
            field_names,
            kind_ids: Vec::new(),
            parent_ids: Vec::new(),
            named: Vec::new(),
            start_row: Vec::new(),
            start_column: Vec::new(),
            start_index: Vec::new(),
            end_row: Vec::new(),
            end_column: Vec::new(),
            end_index: Vec::new(),
            child_count: Vec::new(),
            named_child_count: Vec::new(),
            child_slot: Vec::new(),
            named_child_slot: Vec::new(),
            field_name_id: Vec::new(),
        }
    }

    fn len(&self) -> usize {
        self.kind_ids.len()
    }

    fn push(
        &mut self,
        node: tree_sitter::Node<'_>,
        parent_id: i32,
        child_slot: u32,
        named_child_slot: u32,
        field_name_id: u32,
    ) -> u32 {
        let id = self.kind_ids.len() as u32;
        let kind_id = self.kinds.intern(node.kind());
        let start = node.start_position();
        let end = node.end_position();
        self.kind_ids.push(kind_id);
        self.parent_ids.push(parent_id);
        self.named.push(u8::from(node.is_named()));
        self.start_row.push(start.row as u32);
        self.start_column.push(start.column as u32);
        self.start_index.push(node.start_byte() as u32);
        self.end_row.push(end.row as u32);
        self.end_column.push(end.column as u32);
        self.end_index.push(node.end_byte() as u32);
        self.child_count.push(0);
        self.named_child_count.push(0);
        self.child_slot.push(child_slot);
        self.named_child_slot.push(named_child_slot);
        self.field_name_id.push(field_name_id);
        id
    }
}

fn prefix_sums(counts: &[u32]) -> Vec<u32> {
    let mut offsets = vec![0u32; counts.len() + 1];
    for (index, count) in counts.iter().enumerate() {
        offsets[index + 1] = offsets[index] + count;
    }
    offsets
}

/// Iterative, budgeted projection of a Tree-sitter subtree into flat columns.
/// Ordinary shallow files pay only a small explicit-stack overhead versus recursion.
pub(crate) fn project_columns(
    root: tree_sitter::Node<'_>,
    limits: ProjectionLimits,
) -> Result<ProjectedColumns, ProjectionError> {
    if limits.max_nodes == 0 {
        return Err(ProjectionError::NodeLimit {
            limit: limits.max_nodes,
        });
    }

    struct Frame<'tree> {
        node: tree_sitter::Node<'tree>,
        node_id: u32,
        depth: u32,
        child_index: usize,
    }

    let mut builder = Builder::new();
    let root_id = builder.push(root, -1, 0, 0, 0);
    let mut stack = vec![Frame {
        node: root,
        node_id: root_id,
        depth: 0,
        child_index: 0,
    }];

    // Index rather than `last_mut` so the frame borrow ends before the builder and
    // the stack are touched again.
    while !stack.is_empty() {
        let top = stack.len() - 1;
        if stack[top].child_index >= stack[top].node.child_count() {
            stack.pop();
            continue;
        }

        if stack[top].depth >= limits.max_depth {
            return Err(ProjectionError::DepthLimit {
                limit: limits.max_depth,
            });
        }

        let child_index = stack[top].child_index;
        stack[top].child_index += 1;
        let parent_node = stack[top].node;
        let parent_id = stack[top].node_id;
        let next_depth = stack[top].depth + 1;

        let Some(child) = parent_node.child(child_index) else {
            continue;
        };

        if builder.len() >= limits.max_nodes {
            return Err(ProjectionError::NodeLimit {
                limit: limits.max_nodes,
            });
        }

        let field_name = parent_node
            .field_name_for_child(child_index as u32)
            .unwrap_or("");
        let field_name_id = builder.field_names.intern(field_name);

        let parent = parent_id as usize;
        let child_slot = builder.child_count[parent];
        builder.child_count[parent] = child_slot + 1;
        let named_child_slot = if child.is_named() {
            let slot = builder.named_child_count[parent];
            builder.named_child_count[parent] = slot + 1;
            slot
        } else {
            0
        };

        let child_id = builder.push(child, parent_id as i32, child_slot, named_child_slot, field_name_id);
        stack.push(Frame {
            node: child,
            node_id: child_id,
            depth: next_depth,
            child_index: 0,
        });
    }

    let node_count = builder.len();
    let child_offsets = prefix_sums(&builder.child_count);
    let named_child_offsets = prefix_sums(&builder.named_child_count);
    let mut child_ids = vec![0u32; child_offsets[node_count] as usize];
    let mut child_field_name_ids = vec![0u32; child_offsets[node_count] as usize];
    let mut named_child_ids = vec![0u32; named_child_offsets[node_count] as usize];

    for id in 0..node_count {
        let parent_id = builder.parent_ids[id];
        if parent_id < 0 {
            continue;
        }
        let parent = parent_id as usize;
        let slot = child_offsets[parent] as usize + builder.child_slot[id] as usize;
        child_ids[slot] = id as u32;
        child_field_name_ids[slot] = builder.field_name_id[id];
        if builder.named[id] != 0 {
            let named_slot =
                named_child_offsets[parent] as usize + builder.named_child_slot[id] as usize;
            named_child_ids[named_slot] = id as u32;
        }
    }

    Ok(ProjectedColumns {
        root_id,
        kinds: builder.kinds.values,
        field_names: builder.field_names.values,
        kind_ids: builder.kind_ids,
        parent_ids: builder.parent_ids,
        named: builder.named,
        start_row: builder.start_row,
        start_column: builder.start_column,
        start_index: builder.start_index,
        end_row: builder.end_row,
        end_column: builder.end_column,
        end_index: builder.end_index,
        child_offsets,
        child_ids,
        child_field_name_ids,
        named_child_offsets,
        named_child_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::languages::language_for_id;
    use tree_sitter::Parser;

    fn parse_js(source: &str) -> tree_sitter::Tree {
        let language = language_for_id("js").expect("js language");
        let mut parser = Parser::new();
        parser.set_language(&language).expect("set language");
        parser.parse(source, None).expect("parse")
    }

    fn children_of(columns: &ProjectedColumns, id: usize) -> Vec<u32> {
        let start = columns.child_offsets[id] as usize;
        let end = columns.child_offsets[id + 1] as usize;
        columns.child_ids[start..end].to_vec()
    }

    fn named_children_of(columns: &ProjectedColumns, id: usize) -> Vec<u32> {
        let start = columns.named_child_offsets[id] as usize;
        let end = columns.named_child_offsets[id + 1] as usize;
        columns.named_child_ids[start..end].to_vec()
    }

    #[test]
    fn projects_ordinary_files_within_defaults() {
        let tree = parse_js("function helper() { return 1; }\n");
        let columns =
            project_columns(tree.root_node(), ProjectionLimits::default()).expect("ordinary file should project");
        assert_eq!(columns.root_id, 0);
        assert!(columns.node_count() > 1);
        assert!(columns.node_count() < 1_000);
        // Field names are parallel to the flat child list.
        assert_eq!(columns.child_ids.len(), columns.child_field_name_ids.len());
        // Every column is indexed by node id.
        let count = columns.node_count() as usize;
        assert_eq!(columns.parent_ids.len(), count);
        assert_eq!(columns.named.len(), count);
        assert_eq!(columns.start_index.len(), count);
        assert_eq!(columns.child_offsets.len(), count + 1);
        assert_eq!(columns.parent_ids[0], -1);
    }

    #[test]
    fn interns_kinds_and_field_names_once() {
        let tree = parse_js("function a() { return 1; }\nfunction b() { return 2; }\n");
        let columns = project_columns(tree.root_node(), ProjectionLimits::default()).expect("should project");
        // The table holds distinct kinds only, so it is far smaller than the node count.
        assert!(columns.kinds.len() < columns.node_count() as usize);
        let mut sorted = columns.kinds.clone();
        sorted.sort();
        let before = sorted.len();
        sorted.dedup();
        assert_eq!(sorted.len(), before, "kind table must not repeat a kind");
        assert_eq!(columns.field_names[0], "", "field name id 0 is the empty name");
    }

    #[test]
    fn child_lists_preserve_source_order_and_named_subset() {
        let tree = parse_js("function helper(a, b) { return a; }\n");
        let columns = project_columns(tree.root_node(), ProjectionLimits::default()).expect("should project");

        for id in 0..columns.node_count() as usize {
            let children = children_of(&columns, id);
            // Children appear in ascending byte order.
            for pair in children.windows(2) {
                let left = columns.start_index[pair[0] as usize];
                let right = columns.start_index[pair[1] as usize];
                assert!(left <= right, "children must stay in source order");
            }
            // Every child points back at this parent.
            for child in &children {
                assert_eq!(columns.parent_ids[*child as usize], id as i32);
            }
            // Named children are exactly the named subset, in the same order.
            let expected: Vec<u32> = children
                .iter()
                .copied()
                .filter(|child| columns.named[*child as usize] != 0)
                .collect();
            assert_eq!(named_children_of(&columns, id), expected);
        }
    }

    #[test]
    fn resolves_field_names_to_the_matching_child() {
        let tree = parse_js("function helper() { return 1; }\n");
        let columns = project_columns(tree.root_node(), ProjectionLimits::default()).expect("should project");

        // The function declaration exposes a `name` field pointing at its identifier.
        let declaration = (0..columns.node_count() as usize)
            .find(|id| columns.kinds[columns.kind_ids[*id] as usize] == "function_declaration")
            .expect("function declaration should project");
        let name_id = columns
            .field_names
            .iter()
            .position(|name| name == "name")
            .expect("name field should be interned") as u32;

        let start = columns.child_offsets[declaration] as usize;
        let end = columns.child_offsets[declaration + 1] as usize;
        let slot = (start..end)
            .find(|slot| columns.child_field_name_ids[*slot] == name_id)
            .expect("declaration should carry a name field");
        let name_node = columns.child_ids[slot] as usize;
        assert_eq!(columns.kinds[columns.kind_ids[name_node] as usize], "identifier");
    }

    #[test]
    fn rejects_depth_limit_without_stack_overflow() {
        // Nested arrays: [[[[...]]]] - depth grows with brackets.
        let depth = 40usize;
        let source = format!("{}{}{}", "[".repeat(depth), "1", "]".repeat(depth));
        let tree = parse_js(&source);
        let err = project_columns(
            tree.root_node(),
            ProjectionLimits {
                max_nodes: DEFAULT_MAX_PROJECTED_NODES,
                max_depth: 8,
            },
        )
        .expect_err("deep nesting should hit depth limit");
        assert!(matches!(err, ProjectionError::DepthLimit { limit: 8 }));
        assert!(err.message().contains("max depth limit (8)"));
    }

    #[test]
    fn rejects_node_limit() {
        let tree = parse_js("function helper() { return 1; }\n");
        let err = project_columns(
            tree.root_node(),
            ProjectionLimits {
                max_nodes: 3,
                max_depth: DEFAULT_MAX_PROJECTED_DEPTH,
            },
        )
        .expect_err("tiny node budget should fail");
        assert!(matches!(err, ProjectionError::NodeLimit { limit: 3 }));
    }

    #[test]
    fn rejects_zero_node_budget() {
        let tree = parse_js("const value = 1;\n");
        let err = project_columns(
            tree.root_node(),
            ProjectionLimits {
                max_nodes: 0,
                max_depth: DEFAULT_MAX_PROJECTED_DEPTH,
            },
        )
        .expect_err("a zero budget cannot hold the root");
        assert!(matches!(err, ProjectionError::NodeLimit { limit: 0 }));
    }
}
