use crate::types::{point_with_index, NativeSyntaxNode};

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

fn make_projected_node(node: tree_sitter::Node<'_>, parent_id: Option<u32>, node_id: u32) -> NativeSyntaxNode {
    NativeSyntaxNode {
        id: node_id,
        parent_id: parent_id.map(|id| id as i32).unwrap_or(-1),
        node_type: node.kind().to_string(),
        named: node.is_named(),
        start: point_with_index(node.start_position(), node.start_byte()),
        end: point_with_index(node.end_position(), node.end_byte()),
        child_ids: Vec::new(),
        named_child_ids: Vec::new(),
        child_field_names: Vec::new(),
    }
}

/// Iterative, budgeted projection of a Tree-sitter subtree into a flat node list.
/// Ordinary shallow files pay only a small explicit-stack overhead versus recursion.
pub(crate) fn push_projected_node(
    root: tree_sitter::Node<'_>,
    out: &mut Vec<NativeSyntaxNode>,
    limits: ProjectionLimits,
) -> Result<u32, ProjectionError> {
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
        child_ids: Vec<u32>,
        named_child_ids: Vec<u32>,
        child_field_names: Vec<String>,
    }

    let root_id = out.len() as u32;
    out.push(make_projected_node(root, None, root_id));

    let mut stack = vec![Frame {
        node: root,
        node_id: root_id,
        depth: 0,
        child_index: 0,
        child_ids: Vec::new(),
        named_child_ids: Vec::new(),
        child_field_names: Vec::new(),
    }];

    while let Some(frame) = stack.last_mut() {
        let child_count = frame.node.child_count();
        if frame.child_index < child_count {
            if frame.depth >= limits.max_depth {
                return Err(ProjectionError::DepthLimit {
                    limit: limits.max_depth,
                });
            }

            let child_index = frame.child_index;
            frame.child_index += 1;
            let Some(child) = frame.node.child(child_index) else {
                continue;
            };

            if out.len() >= limits.max_nodes {
                return Err(ProjectionError::NodeLimit {
                    limit: limits.max_nodes,
                });
            }

            let parent_id = frame.node_id;
            let child_id = out.len() as u32;
            let field_name = frame
                .node
                .field_name_for_child(child_index as u32)
                .unwrap_or("")
                .to_string();
            frame.child_ids.push(child_id);
            if child.is_named() {
                frame.named_child_ids.push(child_id);
            }
            frame.child_field_names.push(field_name);

            out.push(make_projected_node(child, Some(parent_id), child_id));
            let next_depth = frame.depth + 1;
            stack.push(Frame {
                node: child,
                node_id: child_id,
                depth: next_depth,
                child_index: 0,
                child_ids: Vec::new(),
                named_child_ids: Vec::new(),
                child_field_names: Vec::new(),
            });
            continue;
        }

        let finished = stack.pop().expect("projection frame must exist");
        let projected = out
            .get_mut(finished.node_id as usize)
            .expect("projected node should exist");
        projected.child_ids = finished.child_ids;
        projected.named_child_ids = finished.named_child_ids;
        projected.child_field_names = finished.child_field_names;
    }

    Ok(root_id)
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

    #[test]
    fn projects_ordinary_files_within_defaults() {
        let tree = parse_js("function helper() { return 1; }\n");
        let mut nodes = Vec::new();
        let root_id = push_projected_node(tree.root_node(), &mut nodes, ProjectionLimits::default())
            .expect("ordinary file should project");
        assert_eq!(root_id, 0);
        assert!(nodes.len() > 1);
        assert!(nodes.len() < 1_000);
        assert_eq!(nodes[0].child_ids.len(), nodes[0].child_field_names.len());
    }

    #[test]
    fn rejects_depth_limit_without_stack_overflow() {
        // Nested arrays: [[[[...]]]] — depth grows with brackets.
        let depth = 40usize;
        let source = format!("{}{}{}", "[".repeat(depth), "1", "]".repeat(depth));
        let tree = parse_js(&source);
        let mut nodes = Vec::new();
        let err = push_projected_node(
            tree.root_node(),
            &mut nodes,
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
        let mut nodes = Vec::new();
        let err = push_projected_node(
            tree.root_node(),
            &mut nodes,
            ProjectionLimits {
                max_nodes: 3,
                max_depth: DEFAULT_MAX_PROJECTED_DEPTH,
            },
        )
        .expect_err("tiny node budget should fail");
        assert!(matches!(err, ProjectionError::NodeLimit { limit: 3 }));
    }
}
