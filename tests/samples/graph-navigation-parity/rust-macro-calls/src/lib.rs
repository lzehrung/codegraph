mod decoy {
    pub fn greet() -> &'static str {
        "decoy"
    }
}

pub fn greet() -> &'static str {
    "hi"
}

pub fn run() -> String {
    format!("{}", greet())
}

pub fn scoped() -> String {
    format!("{}", decoy::greet())
}
