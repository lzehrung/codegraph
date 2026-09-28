pub fn bump() -> i32 { 1 }
pub fn run() -> i32 { 2 }
pub struct Counter;
impl Counter { pub fn bump(&self) -> i32 { 3 } }
pub mod m { pub fn run() -> i32 { 4 } }
pub fn caller(counter: &Counter) {
    println!("{} {} {}", counter./* note */bump(), m::/* note */run(), bump());
}
