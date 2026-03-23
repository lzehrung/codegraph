pub trait Runner {
    fn run(&self);
}

pub enum Mode {
    Fast,
    Slow,
}

pub struct Engine;

impl Runner for Engine {
    fn run(&self) {}
}
