mod helpers;
mod utils;

use helpers::helper_from_helpers as helper_alias;
use utils::helper_function as utils_alias;

fn alias_example() {
    helper_alias();
    utils_alias();
}
