class BoxS { func target(_ x: Int) -> Int { x }; func accepted() -> Int { self.target(1) }; func rejected() -> Int { self.target(1, 2) } }
