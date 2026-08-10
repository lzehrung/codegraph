use self::grouped_targets::{grouped_bar, grouped_baz as renamed_baz};

fn run_scoped() -> i32 {
    grouped_bar() + renamed_baz()
}
