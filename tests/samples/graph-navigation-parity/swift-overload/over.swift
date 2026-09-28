class Box {
    func pick() -> Int { 0 }
    func pick(_ x: Int) -> Int { x }
    func pick(_ x: Int, _ y: Int) -> Int { x + y }
    func pick(_ x: Int, _ transform: (Int) -> Int) -> Int { transform(x) }
    func zero() -> Int { self.pick() }
    func two() -> Int { self.pick(1, 2) }
    func trailing() -> Int { self.pick(1) { x in x } }
}
