use std::collections::HashMap;

struct MyStruct {
    field: i32,
}

impl MyStruct {
    fn new() -> Self {
        MyStruct { field: 0 }
    }

    fn method(&self) {
        println!("Hello");
    }
}

fn function() {
    println!("Function");
}

mod my_mod {
    pub fn mod_function() {}
}

