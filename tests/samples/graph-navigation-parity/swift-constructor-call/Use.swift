class Bar {
    func typed() -> Foo {
        return Foo()
    }

    func direct() -> String {
        return Foo().hello()
    }

    func labeled() -> Worker {
        return Worker(name: "default")
    }

    func hidden() -> String {
        return Foo().secret()
    }
}

extension Worker {
    static func makeDefault() -> Worker {
        Worker(name: "default")
    }
}
