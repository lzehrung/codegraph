pub fn use_item() -> i32 {
    path_dep::item() // @goto customPathItem=item @known-gap cargo_dependency_lib_path observed=not_found
}
