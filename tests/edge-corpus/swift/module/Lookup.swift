class GrandHit {
    func hit() -> String { "grand" } // @def grandHit=hit
}

class PrivateHit: GrandHit {
    private func hit(_ value: Int) -> String { "private" } // @def privateHit=hit
}

class PublicHit: PrivateHit {
    func run() -> String { hit() } // @goto grandHit=hit @known-gap private_method_goto observed=privateHit
    func reference() -> String { hit() } // @ref grandHit @known-gap private_method_reference observed=none
}

class LocalOverload {
    func pick(_ value: Int) -> Int { value } // @def pickOne=pick
    func pick(_ value: Int, _ extra: Int) -> Int { value + extra } // @def pickTwo=pick

    func run() -> Int { pick(1) } // @ref pickOne @goto pickOne=pick
}

class CapitalizedBase {
    func Foo() -> String { "method" } // @def inheritedFoo=Foo
}

class CapitalizedChild: CapitalizedBase {
    func call() -> String { Foo() } // @ref inheritedFoo @goto inheritedFoo=Foo
}

class Foo {}
