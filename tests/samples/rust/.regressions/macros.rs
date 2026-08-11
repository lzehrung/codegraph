macro_rules! make_answer {
    () => { 42 };
}

pub fn invoke() -> i32 {
    make_answer!()
}
