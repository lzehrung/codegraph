mod grouped_targets;

use grouped_targets::{grouped_bar, grouped_baz};

fn run() -> i32 {
    grouped_bar() + grouped_baz()
}
