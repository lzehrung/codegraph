mod utils;

use std::collections::{HashMap, HashSet};
pub use utils::helper;

pub fn main() {
    let mut map = HashMap::new();
    map.insert("a", 1);
    helper();
}
