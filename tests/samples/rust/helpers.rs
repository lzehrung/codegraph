pub fn helper_from_helpers() {}

use serde::Serialize;

#[derive(Serialize)]
struct HelperData {
    value: i32,
}
