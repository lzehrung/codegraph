extern crate serde;
mod utils;

use utils::helper_function as helper_alias;

fn main() {
    helper_alias();
    let _serde_marker = serde::Serializer::is_human_readable;
}
