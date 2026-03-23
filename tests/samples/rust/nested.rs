mod nested_service;

use nested_service::NestedRunner;

fn run_nested() {
    let runner = NestedRunner;
    runner.run();
}
