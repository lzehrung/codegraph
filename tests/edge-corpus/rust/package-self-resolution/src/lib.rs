pub mod item;

pub fn root_value() -> i32 { // @def packageSelfRoot=root_value
    1
}

pub fn library_self_name() -> i32 {
    edge_package::item::value() // @not-ref packageSelfValue
}
