pub fn bump() -> u32 {
    0
}

struct Counter {
    hits: u32,
}

impl Counter {
    fn bump(&mut self) -> u32 {
        self.hits += 1;
        self.hits
    }
}

pub fn run() -> u32 {
    let mut counter = Counter { hits: 0 };
    println!("{}", counter.bump());
    bump()
}
