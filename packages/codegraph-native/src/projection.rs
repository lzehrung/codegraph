use crate::types::{point_with_index, NativeSyntaxNode};

pub(crate) fn push_projected_node(
    node: tree_sitter::Node<'_>,
    parent_id: Option<u32>,
    out: &mut Vec<NativeSyntaxNode>,
) -> u32 {
    let node_id = out.len() as u32;
    let mut child_ids = Vec::new();
    let mut named_child_ids = Vec::new();
    let mut child_field_names = Vec::new();

    out.push(NativeSyntaxNode {
        id: node_id,
        parent_id: parent_id.map(|id| id as i32).unwrap_or(-1),
        node_type: node.kind().to_string(),
        named: node.is_named(),
        start: point_with_index(node.start_position(), node.start_byte()),
        end: point_with_index(node.end_position(), node.end_byte()),
        child_ids: Vec::new(),
        named_child_ids: Vec::new(),
        child_field_names: Vec::new(),
    });

    for child_index in 0..node.child_count() {
        if let Some(child) = node.child(child_index) {
            let child_id = push_projected_node(child, Some(node_id), out);
            child_ids.push(child_id);
            if child.is_named() {
                named_child_ids.push(child_id);
            }
            child_field_names.push(
                node.field_name_for_child(child_index as u32)
                    .unwrap_or("")
                    .to_string(),
            );
        }
    }

    let projected = out
        .get_mut(node_id as usize)
        .expect("projected node should exist");
    projected.child_ids = child_ids;
    projected.named_child_ids = named_child_ids;
    projected.child_field_names = child_field_names;
    node_id
}
