pub mod crate_a;

pub fn use_local_item() -> i32 {
    crate_a::item() // @goto localItem=item @known-gap invalid_path_dependency observed=not_found @not-ref orphanItem
}
